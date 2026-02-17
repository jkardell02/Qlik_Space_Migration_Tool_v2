#!/usr/bin/env node

/**
 * Qlik Cloud Space Migration Tool
 * 
 * A standalone application that runs a local web server and opens
 * the migration tool in your default browser.
 */

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');

// For opening browser - handle both pkg and regular node
let openBrowser;
try {
  openBrowser = require('open');
} catch (e) {
  // Fallback for systems without 'open' package
  openBrowser = async (url) => {
    const { exec } = require('child_process');
    const platform = process.platform;
    let cmd;
    if (platform === 'win32') {
      cmd = `start "" "${url}"`;
    } else if (platform === 'darwin') {
      cmd = `open "${url}"`;
    } else {
      cmd = `xdg-open "${url}"`;
    }
    exec(cmd);
  };
}

// ============================================================================
// IN-MEMORY STORAGE
// ============================================================================
const store = {
  tenants: new Map(),
  migrations: new Map(),
  migrationItems: new Map()
};

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================================================
// QLIK API SERVICE
// ============================================================================
class QlikService {
  constructor(tenantUrl, apiKey) {
    this.tenantUrl = tenantUrl;
    this.apiKey = apiKey;
    this.baseUrl = `https://${tenantUrl}/api/v1`;
  }

  async request(method, endpoint, data = null) {
    const config = {
      method,
      url: `${this.baseUrl}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    };
    if (data) config.data = data;
    const response = await axios(config);
    return response.data;
  }

  async listSpaces() {
    const result = await this.request('GET', '/spaces');
    return result.data || [];
  }

  async getSpace(spaceId) {
    return await this.request('GET', `/spaces/${spaceId}`);
  }

  async renameSpace(spaceId, newName) {
    return await this.request('PATCH', `/spaces/${spaceId}`, [
      { op: 'replace', path: '/name', value: newName }
    ]);
  }

  async listConnections(spaceId = null) {
    let endpoint = '/data-connections?noDatafiles=true';
    if (spaceId) endpoint += `&spaceId=${spaceId}`;
    const result = await this.request('GET', endpoint);
    return result.data || [];
  }

  async duplicateConnection(sourceId, targetSpaceId, newName = null) {
    const payload = { id: sourceId, spaceId: targetSpaceId };
    if (newName) payload.name = newName;
    return await this.request('POST', '/data-connections/actions/duplicate', payload);
  }

  async getDataFilesConnectionId(spaceId) {
    const result = await this.request('GET', '/data-files/connections');
    const connections = result.data || [];
    const conn = connections.find(c => c.spaceId === spaceId);
    return conn ? conn.id : null;
  }

  async listDataFiles(spaceId, includeFolders = true) {
    const connectionId = await this.getDataFilesConnectionId(spaceId);
    let endpoint = '/data-files?limit=100';
    if (connectionId) {
      endpoint += `&connectionId=${connectionId}`;
    } else {
      endpoint += '&includeAllSpaces=true';
    }
    endpoint += `&includeFolders=${includeFolders}`;
    const result = await this.request('GET', endpoint);
    let files = result.data || [];
    if (!connectionId) {
      files = files.filter(f => f.spaceId === spaceId);
    }
    return files;
  }

  async copyDataFile(sourceId, targetConnectionId, fileName) {
    const jsonPayload = { name: fileName, sourceId, connectionId: targetConnectionId };
    const form = new FormData();
    form.append('Json', JSON.stringify(jsonPayload));
    const response = await axios.post(`${this.baseUrl}/data-files`, form, {
      headers: { 'Authorization': `Bearer ${this.apiKey}`, ...form.getHeaders() }
    });
    return response.data;
  }

  async copyFolder(sourceId, targetConnectionId, folderName) {
    const jsonPayload = { name: folderName, folder: true, sourceId, connectionId: targetConnectionId };
    const form = new FormData();
    form.append('Json', JSON.stringify(jsonPayload));
    const response = await axios.post(`${this.baseUrl}/data-files`, form, {
      headers: { 'Authorization': `Bearer ${this.apiKey}`, ...form.getHeaders() }
    });
    return response.data;
  }

  async checkConnectionConflicts(targetSpaceId, connectionNames) {
    const existing = await this.listConnections(targetSpaceId);
    const existingNames = new Set(existing.map(c => c.qName));
    return connectionNames.filter(name => existingNames.has(name));
  }

  async checkFileConflicts(targetSpaceId, fileNames) {
    const existing = await this.listDataFiles(targetSpaceId);
    const existingNames = new Set(existing.map(f => f.name || f.baseName));
    return fileNames.filter(name => existingNames.has(name));
  }
}

// ============================================================================
// MIGRATION SERVICE
// ============================================================================
class MigrationService {
  constructor(qlikService, progressCallback) {
    this.qlik = qlikService;
    this.progressCallback = progressCallback;
  }

  async executeMigration(migration, items) {
    const migrationId = migration.id;
    let completed = 0, failed = 0, skipped = 0;
    const total = items.length;

    migration.status = 'running';
    migration.startedAt = new Date().toISOString();
    store.migrations.set(migrationId, migration);

    const targetConnectionId = await this.qlik.getDataFilesConnectionId(migration.targetSpaceId);

    for (const item of items) {
      if (migration.status === 'cancelled') {
        item.status = 'skipped';
        skipped++;
        continue;
      }

      this.progressCallback({
        migrationId, total, completed, failed, skipped,
        percentage: Math.round((completed / total) * 100),
        currentItem: item.name
      });

      item.status = 'in_progress';
      item.startedAt = new Date().toISOString();

      try {
        if (item.conflictType && item.conflictResolution === 'skip') {
          item.status = 'skipped';
          skipped++;
          continue;
        }

        let newName = item.name;
        if (item.conflictType && item.conflictResolution === 'rename') {
          newName = `${item.name}_copy_${Date.now()}`;
        }

        if (item.itemType === 'connection') {
          const result = await this.qlik.duplicateConnection(item.sourceId, migration.targetSpaceId, newName !== item.name ? newName : null);
          item.targetId = result.qID;
        } else if (item.itemType === 'folder') {
          const result = await this.qlik.copyFolder(item.sourceId, targetConnectionId, newName);
          item.targetId = result.id;
        } else if (item.itemType === 'file') {
          const result = await this.qlik.copyDataFile(item.sourceId, targetConnectionId, newName);
          item.targetId = result.id;
        }

        item.status = 'completed';
        item.completedAt = new Date().toISOString();
        completed++;
      } catch (error) {
        item.status = 'failed';
        item.errorMessage = error.message;
        item.completedAt = new Date().toISOString();
        failed++;
      }

      await new Promise(r => setTimeout(r, 200));
    }

    migration.status = failed === total ? 'failed' : 'completed';
    migration.completedAt = new Date().toISOString();
    migration.progress = { total, completed, failed, skipped, percentage: 100 };
    store.migrations.set(migrationId, migration);
    store.migrationItems.set(migrationId, items);

    return migration;
  }
}

// ============================================================================
// EXPRESS SERVER
// ============================================================================
const app = express();
app.use(express.json());

// Serve static frontend
app.get('/', (req, res) => {
  res.send(getHTML());
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Connect to tenant
app.post('/api/auth/connect', async (req, res) => {
  try {
    const { tenantUrl, apiKey } = req.body;
    if (!tenantUrl || !apiKey) {
      return res.status(400).json({ error: 'tenantUrl and apiKey are required' });
    }
    const qlik = new QlikService(tenantUrl, apiKey);
    const spaces = await qlik.listSpaces();
    const tenantId = generateUUID();
    store.tenants.set(tenantId, { tenantUrl, apiKey, connectedAt: new Date() });
    res.json({ success: true, tenantId, tenantUrl, spacesCount: spaces.length });
  } catch (error) {
    res.status(401).json({ error: 'Failed to connect to Qlik Cloud', details: error.message });
  }
});

// Disconnect
app.post('/api/auth/disconnect', (req, res) => {
  store.tenants.delete(req.body.tenantId);
  res.json({ success: true });
});

// Middleware
const getQlikService = (req, res, next) => {
  const tenantId = req.headers['x-tenant-id'];
  const tenant = store.tenants.get(tenantId);
  if (!tenant) return res.status(401).json({ error: 'Not connected' });
  req.qlik = new QlikService(tenant.tenantUrl, tenant.apiKey);
  req.tenantId = tenantId;
  next();
};

// Spaces
app.get('/api/spaces', getQlikService, async (req, res) => {
  try {
    const spaces = await req.qlik.listSpaces();
    res.json({ spaces, total: spaces.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/spaces/:spaceId', getQlikService, async (req, res) => {
  try {
    const space = await req.qlik.getSpace(req.params.spaceId);
    const connections = await req.qlik.listConnections(req.params.spaceId);
    const files = await req.qlik.listDataFiles(req.params.spaceId);
    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
    res.json({ space, connectionCount: connections.length, fileCount: files.length, totalSize });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/spaces/:spaceId/connections', getQlikService, async (req, res) => {
  try {
    const connections = await req.qlik.listConnections(req.params.spaceId);
    res.json({ connections, total: connections.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/spaces/:spaceId/files', getQlikService, async (req, res) => {
  try {
    const files = await req.qlik.listDataFiles(req.params.spaceId);
    const folders = files.filter(f => f.folder);
    const dataFiles = files.filter(f => !f.folder);
    res.json({ files: dataFiles, folders, total: files.length, totalSize: dataFiles.reduce((s, f) => s + (f.size || 0), 0) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Migrations
app.post('/api/migrations', getQlikService, async (req, res) => {
  try {
    const { sourceSpaceId, targetSpaceId, items, options } = req.body;
    if (!sourceSpaceId || !targetSpaceId || !items?.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const sourceSpace = await req.qlik.getSpace(sourceSpaceId);
    const targetSpace = await req.qlik.getSpace(targetSpaceId);

    const connNames = items.filter(i => i.itemType === 'connection').map(i => i.name);
    const fileNames = items.filter(i => i.itemType !== 'connection').map(i => i.name);
    const connConflicts = await req.qlik.checkConnectionConflicts(targetSpaceId, connNames);
    const fileConflicts = await req.qlik.checkFileConflicts(targetSpaceId, fileNames);
    const allConflicts = [...connConflicts, ...fileConflicts];

    const migrationId = generateUUID();
    const migration = {
      id: migrationId,
      tenantId: req.tenantId,
      sourceSpaceId,
      sourceSpaceName: sourceSpace.name,
      targetSpaceId,
      targetSpaceName: targetSpace.name,
      status: 'created',
      options: options || { mode: 'copy', conflictStrategy: 'skip' },
      progress: { total: items.length, completed: 0, failed: 0, skipped: 0, percentage: 0 },
      createdAt: new Date().toISOString()
    };

    const migrationItems = items.map(item => ({
      id: generateUUID(),
      migrationId,
      sourceId: item.sourceId,
      itemType: item.itemType,
      name: item.name,
      sizeBytes: item.sizeBytes || 0,
      status: 'pending',
      conflictType: allConflicts.includes(item.name) ? 'NAME_EXISTS' : null,
      conflictResolution: allConflicts.includes(item.name) ? (options?.conflictStrategy || 'skip') : null
    }));

    store.migrations.set(migrationId, migration);
    store.migrationItems.set(migrationId, migrationItems);

    res.json({ migration, items: migrationItems, conflicts: allConflicts.map(name => ({ name, type: 'NAME_EXISTS' })) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/migrations/:migrationId', (req, res) => {
  const migration = store.migrations.get(req.params.migrationId);
  const items = store.migrationItems.get(req.params.migrationId);
  if (!migration) return res.status(404).json({ error: 'Not found' });
  res.json({ migration, items });
});

app.get('/api/migrations', (req, res) => {
  const tenantId = req.headers['x-tenant-id'];
  const migrations = Array.from(store.migrations.values())
    .filter(m => m.tenantId === tenantId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ migrations, total: migrations.length });
});

app.post('/api/migrations/:migrationId/start', getQlikService, async (req, res) => {
  const migration = store.migrations.get(req.params.migrationId);
  const items = store.migrationItems.get(req.params.migrationId);
  if (!migration) return res.status(404).json({ error: 'Not found' });
  if (migration.status !== 'created') return res.status(400).json({ error: 'Already started' });

  const svc = new MigrationService(req.qlik, (progress) => {
    const m = store.migrations.get(req.params.migrationId);
    if (m) { m.progress = progress; store.migrations.set(req.params.migrationId, m); }
  });
  svc.executeMigration(migration, items).catch(console.error);

  res.json({ migration, message: 'Started' });
});

app.post('/api/migrations/:migrationId/cancel', (req, res) => {
  const migration = store.migrations.get(req.params.migrationId);
  if (!migration) return res.status(404).json({ error: 'Not found' });
  migration.status = 'cancelled';
  store.migrations.set(req.params.migrationId, migration);
  res.json({ migration, message: 'Cancelled' });
});

// ============================================================================
// START SERVER
// ============================================================================
function findAvailablePort(startPort) {
  return new Promise((resolve) => {
    const server = require('net').createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => resolve(findAvailablePort(startPort + 1)));
  });
}

async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║         Qlik Cloud Space Migration Tool                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  const port = await findAvailablePort(3456);
  
  app.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`✓ Server running at ${url}`);
    console.log('');
    console.log('Opening browser...');
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');
    console.log('Keep this window open while using the application.');
    console.log('Press Ctrl+C to quit.');
    console.log('─────────────────────────────────────────────────────────────');
    
    try {
      await openBrowser(url);
    } catch (e) {
      console.log(`\nCould not open browser automatically.`);
      console.log(`Please open this URL manually: ${url}`);
    }
  });
}

main().catch(console.error);

// ============================================================================
// EMBEDDED HTML
// ============================================================================
function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qlik Migration Tool</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --emerald-50: #ecfdf5; --emerald-100: #d1fae5; --emerald-500: #10b981; --emerald-600: #059669; --emerald-700: #047857;
      --gray-50: #f9fafb; --gray-100: #f3f4f6; --gray-200: #e5e7eb; --gray-300: #d1d5db; --gray-400: #9ca3af;
      --gray-500: #6b7280; --gray-600: #4b5563; --gray-700: #374151; --gray-800: #1f2937; --gray-900: #111827;
      --red-50: #fef2f2; --red-500: #ef4444; --red-600: #dc2626;
      --amber-50: #fffbeb; --amber-100: #fef3c7; --amber-500: #f59e0b; --amber-700: #b45309;
      --blue-50: #eff6ff; --blue-500: #3b82f6; --blue-600: #2563eb;
      --purple-100: #f3e8ff; --purple-600: #9333ea;
      --cyan-100: #cffafe; --cyan-500: #06b6d4; --cyan-600: #0891b2;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--gray-50); color: var(--gray-900); line-height: 1.5; }
    .app { display: flex; height: 100vh; }
    .sidebar { width: 256px; background: var(--gray-900); color: white; display: flex; flex-direction: column; }
    .sidebar-header { padding: 16px; border-bottom: 1px solid var(--gray-800); display: flex; align-items: center; gap: 12px; }
    .sidebar-logo { width: 40px; height: 40px; background: var(--emerald-500); border-radius: 8px; display: flex; align-items: center; justify-content: center; }
    .sidebar-title { font-weight: 600; }
    .sidebar-subtitle { font-size: 12px; color: var(--gray-400); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sidebar-nav { flex: 1; padding: 16px; }
    .nav-item { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 8px; color: var(--gray-400); cursor: pointer; border: none; background: none; width: 100%; text-align: left; font-size: 14px; transition: all 0.2s; }
    .nav-item:hover { background: var(--gray-800); color: white; }
    .nav-item.active { background: var(--emerald-600); color: white; }
    .sidebar-footer { padding: 16px; border-top: 1px solid var(--gray-800); }
    .main { flex: 1; overflow: auto; padding: 32px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border: 1px solid var(--gray-200); }
    .card-header { padding: 16px; border-bottom: 1px solid var(--gray-200); font-weight: 600; }
    .card-body { padding: 24px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; border: none; transition: all 0.2s; }
    .btn-primary { background: var(--emerald-600); color: white; }
    .btn-primary:hover { background: var(--emerald-700); }
    .btn-secondary { background: var(--gray-100); color: var(--gray-700); }
    .btn-secondary:hover { background: var(--gray-200); }
    .btn-danger { background: var(--red-500); color: white; }
    .btn-ghost { background: transparent; color: var(--gray-600); }
    .btn-ghost:hover { background: var(--gray-100); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-block { width: 100%; }
    .form-group { margin-bottom: 16px; }
    .form-label { display: block; font-size: 14px; font-weight: 500; color: var(--gray-700); margin-bottom: 4px; }
    .form-input { width: 100%; padding: 8px 12px; border: 1px solid var(--gray-300); border-radius: 8px; font-size: 14px; }
    .form-input:focus { outline: none; border-color: var(--emerald-500); box-shadow: 0 0 0 3px rgba(16,185,129,0.1); }
    .form-hint { font-size: 12px; color: var(--gray-500); margin-top: 4px; }
    .badge { display: inline-flex; padding: 2px 10px; border-radius: 9999px; font-size: 12px; font-weight: 500; }
    .badge-gray { background: var(--gray-100); color: var(--gray-700); }
    .badge-green { background: var(--emerald-100); color: var(--emerald-700); }
    .badge-red { background: var(--red-50); color: var(--red-600); }
    .badge-amber { background: var(--amber-100); color: var(--amber-700); }
    .badge-purple { background: var(--purple-100); color: var(--purple-600); }
    .badge-cyan { background: var(--cyan-100); color: var(--cyan-600); }
    .alert { padding: 12px 16px; border-radius: 8px; display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .alert-error { background: var(--red-50); color: var(--red-600); border: 1px solid #fecaca; }
    .alert-warning { background: var(--amber-50); color: var(--amber-700); border: 1px solid var(--amber-100); }
    .alert-info { background: var(--blue-50); color: var(--blue-600); border: 1px solid #bfdbfe; }
    .alert-success { background: var(--emerald-50); color: var(--emerald-700); border: 1px solid var(--emerald-100); }
    .progress { width: 100%; height: 12px; background: var(--gray-200); border-radius: 9999px; overflow: hidden; }
    .progress-bar { height: 100%; background: var(--emerald-500); border-radius: 9999px; transition: width 0.3s; }
    .grid { display: grid; gap: 16px; }
    .grid-2 { grid-template-columns: repeat(2, 1fr); }
    .grid-3 { grid-template-columns: repeat(3, 1fr); }
    .grid-4 { grid-template-columns: repeat(4, 1fr); }
    .mb-2 { margin-bottom: 8px; } .mb-4 { margin-bottom: 16px; } .mb-6 { margin-bottom: 24px; }
    .mt-4 { margin-top: 16px; } .mt-6 { margin-top: 24px; }
    .p-4 { padding: 16px; } .p-6 { padding: 24px; }
    .flex { display: flex; } .flex-col { flex-direction: column; }
    .items-center { align-items: center; } .justify-between { justify-content: space-between; } .justify-center { justify-content: center; }
    .gap-2 { gap: 8px; } .gap-4 { gap: 16px; } .flex-1 { flex: 1; }
    .text-center { text-align: center; }
    .text-sm { font-size: 14px; } .text-xs { font-size: 12px; } .text-lg { font-size: 18px; } .text-xl { font-size: 20px; } .text-2xl { font-size: 24px; }
    .font-medium { font-weight: 500; } .font-semibold { font-weight: 600; } .font-bold { font-weight: 700; }
    .text-gray-500 { color: var(--gray-500); } .text-gray-600 { color: var(--gray-600); } .text-gray-900 { color: var(--gray-900); }
    .text-emerald-600 { color: var(--emerald-600); } .text-emerald-700 { color: var(--emerald-700); }
    .rounded-lg { border-radius: 8px; } .rounded-xl { border-radius: 12px; }
    .bg-gray-50 { background: var(--gray-50); } .bg-emerald-50 { background: var(--emerald-50); }
    .border { border: 1px solid var(--gray-200); }
    .cursor-pointer { cursor: pointer; } .overflow-auto { overflow: auto; } .max-h-64 { max-height: 256px; } .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hidden { display: none !important; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .animate-spin { animation: spin 1s linear infinite; }
    .login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, var(--emerald-50), var(--cyan-100)); padding: 16px; }
    .login-card { width: 100%; max-width: 400px; }
    .login-logo { width: 64px; height: 64px; background: var(--emerald-100); border-radius: 16px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; }
    .selectable-item { padding: 12px; border-radius: 8px; border: 1px solid var(--gray-200); cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    .selectable-item:hover { border-color: var(--gray-300); }
    .selectable-item.selected { border-color: var(--emerald-500); background: var(--emerald-50); }
    .checkbox { width: 20px; height: 20px; border: 2px solid var(--gray-300); border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .selectable-item.selected .checkbox { border-color: var(--emerald-500); background: var(--emerald-500); }
    .steps { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
    .step { display: flex; align-items: center; gap: 8px; }
    .step-number { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 500; background: var(--gray-100); color: var(--gray-400); }
    .step.active .step-number { background: var(--emerald-100); color: var(--emerald-600); border: 2px solid var(--emerald-600); }
    .step.completed .step-number { background: var(--emerald-600); color: white; }
    .step-label { font-size: 14px; font-weight: 500; color: var(--gray-400); }
    .step.active .step-label, .step.completed .step-label { color: var(--emerald-600); }
    .step-divider { color: var(--gray-300); }
    .stat-card { padding: 24px; border-radius: 12px; }
    .stat-card.gradient { background: linear-gradient(135deg, var(--emerald-500), var(--cyan-500)); color: white; }
    .stat-icon { width: 48px; height: 48px; border-radius: 12px; display: flex; align-items: center; justify-content: center; }
    .icon { width: 20px; height: 20px; flex-shrink: 0; }
    .icon-sm { width: 16px; height: 16px; }
    .icon-lg { width: 24px; height: 24px; }
    .icon-xl { width: 48px; height: 48px; }
    svg { display: inline-block; vertical-align: middle; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script>
    const Icons = {
      database: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
      folder: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
      file: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>',
      check: '<svg class="icon icon-sm" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><polyline points="20,6 9,17 4,12"/></svg>',
      loader: '<svg class="icon animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
      arrowRight: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12,5 19,12 12,19"/></svg>',
      chevronRight: '<svg class="icon icon-sm" fill="none" stroke="currentColor" viewBox="0 0 24 24"><polyline points="9,18 15,12 9,6"/></svg>',
      play: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><polygon points="5,3 19,12 5,21 5,3"/></svg>',
      copy: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      plus: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
      checkCircle: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>',
      xCircle: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      layout: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
      history: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
      logOut: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16,17 21,12 16,7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
      refresh: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      skip: '<svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><polygon points="5,4 15,12 5,20 5,4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
    };

    const API_BASE = '';
    const api = {
      tenantId: localStorage.getItem('tenantId'),
      async request(method, endpoint, data = null) {
        const config = { method, headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': this.tenantId || '' } };
        if (data) config.body = JSON.stringify(data);
        const response = await fetch(API_BASE + endpoint, config);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'API request failed');
        return result;
      },
      async connect(tenantUrl, apiKey) {
        const result = await this.request('POST', '/api/auth/connect', { tenantUrl, apiKey });
        this.tenantId = result.tenantId;
        localStorage.setItem('tenantId', result.tenantId);
        localStorage.setItem('tenantUrl', result.tenantUrl);
        return result;
      },
      async disconnect() {
        await this.request('POST', '/api/auth/disconnect', { tenantId: this.tenantId });
        this.tenantId = null;
        localStorage.removeItem('tenantId');
        localStorage.removeItem('tenantUrl');
      },
      listSpaces() { return this.request('GET', '/api/spaces'); },
      getSpace(id) { return this.request('GET', '/api/spaces/' + id); },
      listConnections(spaceId) { return this.request('GET', '/api/spaces/' + spaceId + '/connections'); },
      listFiles(spaceId) { return this.request('GET', '/api/spaces/' + spaceId + '/files'); },
      createMigration(s, t, items, opts) { return this.request('POST', '/api/migrations', { sourceSpaceId: s, targetSpaceId: t, items, options: opts }); },
      getMigration(id) { return this.request('GET', '/api/migrations/' + id); },
      listMigrations() { return this.request('GET', '/api/migrations'); },
      startMigration(id) { return this.request('POST', '/api/migrations/' + id + '/start'); },
    };

    let state = {
      isConnected: !!localStorage.getItem('tenantId'),
      tenantUrl: localStorage.getItem('tenantUrl') || '',
      currentPage: 'dashboard',
      spaces: [],
      migrations: [],
      wizard: { step: 1, sourceSpace: null, targetSpace: null, connections: [], files: [], selectedItems: [], migration: null, migrationItems: [], conflicts: [], progress: null }
    };

    function setState(u) { state = { ...state, ...u }; render(); }
    function setWizardState(u) { state.wizard = { ...state.wizard, ...u }; render(); }
    function formatBytes(b) { if (b === 0) return '0 B'; const k = 1024; const s = ['B', 'KB', 'MB', 'GB']; const i = Math.floor(Math.log(b) / Math.log(k)); return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + s[i]; }
    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    function renderLoginPage() {
      return '<div class="login-page"><div class="card login-card"><div class="card-body text-center"><div class="login-logo">' + Icons.database.replace('class="icon"', 'class="icon icon-lg" style="color:var(--emerald-600)"') + '</div><h1 class="text-2xl font-bold mb-2">Qlik Migration Tool</h1><p class="text-gray-500 mb-6">Connect to your Qlik Cloud tenant</p><form onsubmit="handleLogin(event)" class="text-left"><div class="form-group"><label class="form-label">Tenant URL</label><input type="text" id="tenantUrl" class="form-input" placeholder="your-tenant.us.qlikcloud.com" required></div><div class="form-group"><label class="form-label">API Key</label><input type="password" id="apiKey" class="form-input" placeholder="Enter your API key" required><p class="form-hint">Generate at Settings → API Keys</p></div><div id="loginError" class="alert alert-error hidden"></div><button type="submit" id="loginBtn" class="btn btn-primary btn-block">Connect to Qlik Cloud</button></form></div></div></div>';
    }

    function renderSidebar() {
      const items = [{ id: 'dashboard', label: 'Dashboard', icon: 'layout' }, { id: 'spaces', label: 'Spaces', icon: 'folder' }, { id: 'migrations', label: 'New Migration', icon: 'copy' }, { id: 'history', label: 'History', icon: 'history' }];
      return '<div class="sidebar"><div class="sidebar-header"><div class="sidebar-logo">' + Icons.database.replace('class="icon"', 'style="width:20px;height:20px;color:white"') + '</div><div><div class="sidebar-title">Migration Tool</div><div class="sidebar-subtitle">' + esc(state.tenantUrl) + '</div></div></div><nav class="sidebar-nav">' + items.map(i => '<button class="nav-item ' + (state.currentPage === i.id ? 'active' : '') + '" onclick="navigate(\\'' + i.id + '\\')">' + Icons[i.icon] + '<span>' + i.label + '</span></button>').join('') + '</nav><div class="sidebar-footer"><button class="nav-item" onclick="handleDisconnect()">' + Icons.logOut + '<span>Disconnect</span></button></div></div>';
    }

    function renderDashboard() {
      return '<div><h1 class="text-2xl font-bold mb-2">Dashboard</h1><p class="text-gray-600 mb-6">Welcome to the Qlik Space Migration Tool</p><div class="grid grid-3 mb-6"><div class="card stat-card"><div class="flex items-center gap-4"><div class="stat-icon" style="background:var(--purple-100)">' + Icons.folder.replace('class="icon"', 'class="icon icon-lg" style="color:var(--purple-600)"') + '</div><div><p class="text-2xl font-bold">' + state.spaces.length + '</p><p class="text-gray-600">Available Spaces</p></div></div></div><div class="card stat-card"><div class="flex items-center gap-4"><div class="stat-icon" style="background:var(--emerald-100)">' + Icons.copy.replace('class="icon"', 'class="icon icon-lg" style="color:var(--emerald-600)"') + '</div><div><p class="text-2xl font-bold">' + state.migrations.length + '</p><p class="text-gray-600">Total Migrations</p></div></div></div><div class="card stat-card gradient"><div class="flex items-center justify-between"><div><p class="text-lg font-semibold">Start New Migration</p><p style="opacity:0.8" class="text-sm">Copy content between spaces</p></div><button class="btn btn-secondary" onclick="navigate(\\'migrations\\')">' + Icons.plus + ' New</button></div></div></div></div>';
    }

    function renderSpaces() {
      return '<div><div class="flex items-center justify-between mb-6"><div><h1 class="text-2xl font-bold">Spaces</h1><p class="text-gray-600">Browse your Qlik Cloud spaces</p></div><button class="btn btn-secondary" onclick="loadSpaces()">' + Icons.refresh + ' Refresh</button></div><div class="grid grid-2">' + state.spaces.map(s => '<div class="card p-4"><div class="flex items-center gap-4"><div class="stat-icon" style="background:' + (s.type === 'shared' ? 'var(--purple-100)' : 'var(--cyan-100)') + '">' + Icons.folder.replace('class="icon"', 'class="icon" style="color:' + (s.type === 'shared' ? 'var(--purple-600)' : 'var(--cyan-600)') + '"') + '</div><div class="flex-1"><p class="font-medium">' + esc(s.name) + '</p><p class="text-sm text-gray-500">ID: ' + s.id.substring(0, 8) + '...</p></div><span class="badge ' + (s.type === 'shared' ? 'badge-purple' : 'badge-cyan') + '">' + s.type + '</span></div></div>').join('') + '</div></div>';
    }

    function renderMigrationWizard() {
      const { step, sourceSpace, targetSpace, connections, files, selectedItems, migration, migrationItems, progress } = state.wizard;
      const steps = [{ n: 1, l: 'Spaces' }, { n: 2, l: 'Items' }, { n: 3, l: 'Review' }, { n: 4, l: 'Progress' }, { n: 5, l: 'Done' }];
      let content = '';

      if (step === 1) {
        content = '<div class="grid grid-2 gap-4 mb-6"><div><h3 class="font-medium mb-4">Source Space (copy FROM)</h3><div class="max-h-64 overflow-auto">' + state.spaces.map(s => '<div class="selectable-item ' + (sourceSpace?.id === s.id ? 'selected' : '') + '" onclick="selectSourceSpace(\\'' + s.id + '\\')"><div class="flex-1"><span class="font-medium">' + esc(s.name) + '</span></div><span class="badge ' + (s.type === 'shared' ? 'badge-purple' : 'badge-cyan') + '">' + s.type + '</span></div>').join('') + '</div></div><div><h3 class="font-medium mb-4">Target Space (copy TO)</h3><div class="max-h-64 overflow-auto">' + state.spaces.filter(s => s.id !== sourceSpace?.id).map(s => '<div class="selectable-item ' + (targetSpace?.id === s.id ? 'selected' : '') + ' ' + (!sourceSpace ? 'opacity-50' : '') + '" onclick="' + (sourceSpace ? "selectTargetSpace('" + s.id + "')" : '') + '"><div class="flex-1"><span class="font-medium">' + esc(s.name) + '</span></div><span class="badge ' + (s.type === 'shared' ? 'badge-purple' : 'badge-cyan') + '">' + s.type + '</span></div>').join('') + '</div></div></div>' + (sourceSpace && targetSpace ? '<div class="alert alert-success mb-6"><strong>' + esc(sourceSpace.name) + '</strong><span style="margin:0 8px">→</span><strong>' + esc(targetSpace.name) + '</strong></div>' : '') + '<div class="flex justify-end"><button class="btn btn-primary" ' + (!sourceSpace || !targetSpace ? 'disabled' : '') + ' onclick="wizardNext()">Next: Select Items ' + Icons.chevronRight + '</button></div>';
      } else if (step === 2) {
        content = '<div class="alert alert-info mb-4">' + esc(sourceSpace.name) + ' → ' + esc(targetSpace.name) + ' | ' + selectedItems.length + ' items selected (' + formatBytes(selectedItems.reduce((s, i) => s + (i.sizeBytes || 0), 0)) + ')</div><div class="grid grid-2 gap-4 mb-6"><div><div class="flex items-center justify-between mb-4"><h3 class="font-medium">Data Connections (' + connections.length + ')</h3><button class="btn btn-ghost" onclick="selectAllConnections()">Select All</button></div><div class="border rounded-lg p-2 max-h-64 overflow-auto">' + (connections.length === 0 ? '<p class="text-center text-gray-500 p-4">No connections</p>' : connections.map(c => { const sel = selectedItems.some(i => i.sourceId === c.qID); return '<div class="selectable-item ' + (sel ? 'selected' : '') + '" onclick="toggleItem(\\'' + c.qID + '\\',\\'connection\\',\\'' + esc(c.qName).replace(/'/g, "\\\\'") + '\\',0)"><div class="checkbox">' + (sel ? Icons.check.replace('class="', 'class="text-white ') : '') + '</div>' + Icons.database + '<span class="flex-1 truncate">' + esc(c.qName) + '</span></div>'; }).join('')) + '</div></div><div><div class="flex items-center justify-between mb-4"><h3 class="font-medium">Data Files (' + files.length + ')</h3><button class="btn btn-ghost" onclick="selectAllFiles()">Select All</button></div><div class="border rounded-lg p-2 max-h-64 overflow-auto">' + (files.length === 0 ? '<p class="text-center text-gray-500 p-4">No files</p>' : files.map(f => { const t = f.folder ? 'folder' : 'file'; const sel = selectedItems.some(i => i.sourceId === f.id); return '<div class="selectable-item ' + (sel ? 'selected' : '') + '" onclick="toggleItem(\\'' + f.id + '\\',\\'' + t + '\\',\\'' + esc(f.name || f.baseName).replace(/'/g, "\\\\'") + '\\',' + (f.size || 0) + ')"><div class="checkbox">' + (sel ? Icons.check.replace('class="', 'class="text-white ') : '') + '</div>' + (f.folder ? Icons.folder : Icons.file) + '<span class="flex-1 truncate">' + esc(f.name || f.baseName) + '</span>' + (!f.folder ? '<span class="text-xs text-gray-500">' + formatBytes(f.size || 0) + '</span>' : '') + '</div>'; }).join('')) + '</div></div></div><div class="flex justify-between"><button class="btn btn-secondary" onclick="wizardBack()">Back</button><button class="btn btn-primary" ' + (selectedItems.length === 0 ? 'disabled' : '') + ' onclick="createMigration()">Next: Review ' + Icons.chevronRight + '</button></div>';
      } else if (step === 3) {
        const cc = migrationItems.filter(i => i.itemType === 'connection').length;
        const fc = migrationItems.filter(i => i.itemType !== 'connection').length;
        const ts = migrationItems.reduce((s, i) => s + (i.sizeBytes || 0), 0);
        content = '<div class="text-center mb-6"><h3 class="text-lg font-medium">Ready to Start Migration</h3><p class="text-gray-600">Review the details below.</p></div><div class="grid grid-2 gap-4 mb-6"><div class="p-4 bg-gray-50 rounded-lg"><p class="text-sm text-gray-500">Source Space</p><p class="font-medium">' + esc(migration.sourceSpaceName) + '</p></div><div class="p-4 bg-gray-50 rounded-lg"><p class="text-sm text-gray-500">Target Space</p><p class="font-medium">' + esc(migration.targetSpaceName) + '</p></div></div><div class="grid grid-3 gap-4 mb-6"><div class="p-4 bg-emerald-50 rounded-lg text-center">' + Icons.database.replace('class="icon"', 'class="icon icon-lg" style="color:var(--emerald-600);margin:0 auto 8px"') + '<p class="text-2xl font-bold text-emerald-700">' + cc + '</p><p class="text-sm text-emerald-600">Connections</p></div><div class="p-4" style="background:var(--blue-50);border-radius:8px;text-center">' + Icons.file.replace('class="icon"', 'class="icon icon-lg" style="color:var(--blue-600);margin:0 auto 8px"') + '<p class="text-2xl font-bold" style="color:var(--blue-700)">' + fc + '</p><p class="text-sm" style="color:var(--blue-600)">Files/Folders</p></div><div class="p-4" style="background:var(--purple-100);border-radius:8px;text-center">' + Icons.copy.replace('class="icon"', 'class="icon icon-lg" style="color:var(--purple-600);margin:0 auto 8px"') + '<p class="text-2xl font-bold" style="color:var(--purple-700)">' + formatBytes(ts) + '</p><p class="text-sm" style="color:var(--purple-600)">Total Size</p></div></div><div class="alert alert-info mb-6"><strong>Note:</strong> This will COPY items. Originals remain in the source space.</div><div class="flex justify-between"><button class="btn btn-secondary" onclick="wizardBack()">Back</button><button class="btn btn-primary" onclick="startMigration()">' + Icons.play + ' Start Migration</button></div>';
      } else if (step === 4) {
        const c = progress?.completed || 0;
        const t = progress?.total || migrationItems.length;
        const p = t > 0 ? Math.round((c / t) * 100) : 0;
        content = '<div class="text-center mb-6">' + Icons.loader.replace('class="icon', 'class="icon icon-xl" style="color:var(--emerald-600);margin:0 auto 16px') + '<h3 class="text-lg font-medium">Migration in Progress</h3><p class="text-gray-600">Please wait...</p></div><div class="mb-6"><div class="flex justify-between mb-2"><span class="text-sm text-gray-600">' + p + '%</span><span class="text-sm text-gray-600">' + c + ' / ' + t + ' items</span></div><div class="progress"><div class="progress-bar" style="width:' + p + '%"></div></div></div><div class="grid grid-4 gap-4"><div class="p-4 bg-gray-50 rounded-lg text-center"><p class="text-xl font-bold">' + t + '</p><p class="text-sm text-gray-500">Total</p></div><div class="p-4 bg-emerald-50 rounded-lg text-center"><p class="text-xl font-bold text-emerald-600">' + c + '</p><p class="text-sm text-emerald-600">Completed</p></div><div class="p-4 bg-red-50 rounded-lg text-center"><p class="text-xl font-bold text-red-600">' + (progress?.failed || 0) + '</p><p class="text-sm text-red-600">Failed</p></div><div class="p-4 bg-gray-50 rounded-lg text-center"><p class="text-xl font-bold text-gray-600">' + (progress?.skipped || 0) + '</p><p class="text-sm text-gray-500">Skipped</p></div></div>';
      } else if (step === 5) {
        const comp = migrationItems.filter(i => i.status === 'completed').length;
        const fail = migrationItems.filter(i => i.status === 'failed').length;
        const skip = migrationItems.filter(i => i.status === 'skipped').length;
        const ok = migration?.status === 'completed' && fail === 0;
        content = '<div class="text-center mb-6">' + (ok ? Icons.checkCircle.replace('class="icon"', 'style="width:64px;height:64px;color:var(--emerald-500);margin:0 auto 16px"') : Icons.xCircle.replace('class="icon"', 'style="width:64px;height:64px;color:var(--amber-500);margin:0 auto 16px"')) + '<h3 class="text-xl font-medium">' + (ok ? 'Migration Completed Successfully!' : 'Completed with Issues') + '</h3></div><div class="grid grid-3 gap-4 mb-6"><div class="p-4 bg-emerald-50 rounded-lg text-center">' + Icons.checkCircle.replace('class="icon"', 'class="icon icon-lg" style="color:var(--emerald-600);margin:0 auto 8px"') + '<p class="text-2xl font-bold text-emerald-700">' + comp + '</p><p class="text-sm text-emerald-600">Completed</p></div><div class="p-4 bg-red-50 rounded-lg text-center">' + Icons.xCircle.replace('class="icon"', 'class="icon icon-lg" style="color:var(--red-500);margin:0 auto 8px"') + '<p class="text-2xl font-bold text-red-600">' + fail + '</p><p class="text-sm text-red-600">Failed</p></div><div class="p-4 bg-gray-50 rounded-lg text-center">' + Icons.skip.replace('class="icon"', 'class="icon icon-lg" style="color:var(--gray-500);margin:0 auto 8px"') + '<p class="text-2xl font-bold text-gray-700">' + skip + '</p><p class="text-sm text-gray-600">Skipped</p></div></div><div class="alert alert-info mb-6"><strong>Remember:</strong> Originals remain in the source space.</div><div class="text-center"><button class="btn btn-primary" onclick="resetWizard()">' + Icons.plus + ' Start New Migration</button></div>';
      }

      return '<div><h1 class="text-2xl font-bold mb-2">New Migration</h1><p class="text-gray-600 mb-6">Copy connections and files between spaces</p><div class="steps">' + steps.map((s, i) => '<div class="step ' + (step > s.n ? 'completed' : step === s.n ? 'active' : '') + '"><div class="step-number">' + (step > s.n ? Icons.check : s.n) + '</div><span class="step-label">' + s.l + '</span></div>' + (i < steps.length - 1 ? '<span class="step-divider">' + Icons.chevronRight + '</span>' : '')).join('') + '</div><div class="card p-6">' + content + '</div></div>';
    }

    function renderHistory() {
      return '<div><div class="flex items-center justify-between mb-6"><div><h1 class="text-2xl font-bold">Migration History</h1><p class="text-gray-600">View past migrations</p></div><button class="btn btn-secondary" onclick="loadMigrations()">' + Icons.refresh + ' Refresh</button></div><div class="card">' + (state.migrations.length === 0 ? '<div class="p-6 text-center text-gray-500">' + Icons.history.replace('class="icon"', 'class="icon icon-xl" style="color:var(--gray-300);margin:0 auto 16px"') + '<p>No migration history yet</p></div>' : state.migrations.map(m => '<div class="p-4 flex items-center justify-between border-b"><div class="flex items-center gap-4">' + (m.status === 'completed' ? Icons.checkCircle.replace('class="icon"', 'style="width:20px;height:20px;color:var(--emerald-500)"') : m.status === 'failed' ? Icons.xCircle.replace('class="icon"', 'style="width:20px;height:20px;color:var(--red-500)"') : Icons.loader) + '<div><p class="font-medium">' + esc(m.sourceSpaceName) + ' → ' + esc(m.targetSpaceName) + '</p><p class="text-sm text-gray-500">' + new Date(m.createdAt).toLocaleString() + '</p></div></div><span class="badge ' + (m.status === 'completed' ? 'badge-green' : m.status === 'failed' ? 'badge-red' : 'badge-gray') + '">' + m.status + '</span></div>').join('')) + '</div></div>';
    }

    async function handleLogin(e) {
      e.preventDefault();
      const btn = document.getElementById('loginBtn');
      const err = document.getElementById('loginError');
      const url = document.getElementById('tenantUrl').value;
      const key = document.getElementById('apiKey').value;
      btn.disabled = true;
      btn.innerHTML = Icons.loader + ' Connecting...';
      err.classList.add('hidden');
      try {
        await api.connect(url, key);
        setState({ isConnected: true, tenantUrl: url });
        await loadInitialData();
      } catch (error) {
        err.textContent = error.message;
        err.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = 'Connect to Qlik Cloud';
      }
    }

    async function handleDisconnect() {
      try { await api.disconnect(); } catch (e) {}
      setState({ isConnected: false, tenantUrl: '', spaces: [], migrations: [] });
    }

    function navigate(page) {
      setState({ currentPage: page });
      if (page === 'migrations') resetWizard();
    }

    async function loadInitialData() { await Promise.all([loadSpaces(), loadMigrations()]); }
    async function loadSpaces() { try { const r = await api.listSpaces(); setState({ spaces: r.spaces }); } catch (e) { console.error(e); } }
    async function loadMigrations() { try { const r = await api.listMigrations(); setState({ migrations: r.migrations }); } catch (e) { console.error(e); } }

    function selectSourceSpace(id) { const s = state.spaces.find(x => x.id === id); setWizardState({ sourceSpace: s, targetSpace: null, selectedItems: [] }); }
    function selectTargetSpace(id) { const s = state.spaces.find(x => x.id === id); setWizardState({ targetSpace: s }); }

    async function wizardNext() {
      const { step, sourceSpace } = state.wizard;
      if (step === 1) {
        try {
          const [c, f] = await Promise.all([api.listConnections(sourceSpace.id), api.listFiles(sourceSpace.id)]);
          setWizardState({ step: 2, connections: c.connections, files: [...(f.folders || []), ...(f.files || [])] });
        } catch (e) { console.error(e); }
      }
    }

    function wizardBack() { setWizardState({ step: state.wizard.step - 1 }); }

    function toggleItem(sourceId, itemType, name, sizeBytes) {
      const { selectedItems } = state.wizard;
      const exists = selectedItems.find(i => i.sourceId === sourceId);
      if (exists) setWizardState({ selectedItems: selectedItems.filter(i => i.sourceId !== sourceId) });
      else setWizardState({ selectedItems: [...selectedItems, { sourceId, itemType, name, sizeBytes }] });
    }

    function selectAllConnections() {
      const { connections, selectedItems } = state.wizard;
      const items = connections.map(c => ({ sourceId: c.qID, itemType: 'connection', name: c.qName, sizeBytes: 0 }));
      const others = selectedItems.filter(i => i.itemType !== 'connection');
      setWizardState({ selectedItems: [...others, ...items] });
    }

    function selectAllFiles() {
      const { files, selectedItems } = state.wizard;
      const items = files.map(f => ({ sourceId: f.id, itemType: f.folder ? 'folder' : 'file', name: f.name || f.baseName, sizeBytes: f.size || 0 }));
      const others = selectedItems.filter(i => i.itemType === 'connection');
      setWizardState({ selectedItems: [...others, ...items] });
    }

    async function createMigration() {
      const { sourceSpace, targetSpace, selectedItems } = state.wizard;
      try {
        const r = await api.createMigration(sourceSpace.id, targetSpace.id, selectedItems, { mode: 'copy', conflictStrategy: 'skip' });
        setWizardState({ step: 3, migration: r.migration, migrationItems: r.items, conflicts: r.conflicts });
      } catch (e) { alert('Failed: ' + e.message); }
    }

    async function startMigration() {
      try {
        await api.startMigration(state.wizard.migration.id);
        setWizardState({ step: 4 });
        pollProgress();
      } catch (e) { console.error(e); }
    }

    function pollProgress() {
      const interval = setInterval(async () => {
        try {
          const r = await api.getMigration(state.wizard.migration.id);
          setWizardState({ migration: r.migration, migrationItems: r.items, progress: r.migration.progress });
          if (['completed', 'failed', 'cancelled'].includes(r.migration.status)) {
            clearInterval(interval);
            setWizardState({ step: 5 });
            loadMigrations();
          }
        } catch (e) { console.error(e); }
      }, 1000);
    }

    function resetWizard() {
      setWizardState({ step: 1, sourceSpace: null, targetSpace: null, connections: [], files: [], selectedItems: [], migration: null, migrationItems: [], conflicts: [], progress: null });
    }

    function render() {
      const app = document.getElementById('app');
      if (!state.isConnected) { app.innerHTML = renderLoginPage(); return; }
      let page = '';
      switch (state.currentPage) {
        case 'dashboard': page = renderDashboard(); break;
        case 'spaces': page = renderSpaces(); break;
        case 'migrations': page = renderMigrationWizard(); break;
        case 'history': page = renderHistory(); break;
        default: page = renderDashboard();
      }
      app.innerHTML = '<div class="app">' + renderSidebar() + '<main class="main">' + page + '</main></div>';
    }

    render();
    if (state.isConnected) loadInitialData();
  </script>
</body>
</html>`;
}
