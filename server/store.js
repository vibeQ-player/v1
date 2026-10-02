import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Conflict extends Error {}
export async function createStore(cfg) {
  if (cfg.storage === 'cosmos') {
    const { CosmosClient } = await import('@azure/cosmos');
    if (!cfg.cosmosEndpoint || !cfg.cosmosKey) throw new Error('COSMOS_ENDPOINT and COSMOS_KEY are required for Cosmos mode.');
    const client = new CosmosClient({ endpoint: cfg.cosmosEndpoint, key: cfg.cosmosKey });
    // Provisioning happens in deployment, never on every public API request.
    const container = client.database(cfg.cosmosDatabase).container('documents');
    return {
      async get(collection, id) {
        try { const { resource } = await container.item(id, collection).read(); return resource || null; }
        catch (e) { if (e.code === 404) return null; throw e; }
      },
      async list(collection) {
        const { resources } = await container.items.query({ query: 'SELECT * FROM c WHERE c.collection = @collection', parameters: [{ name: '@collection', value: collection }] }, { partitionKey: collection }).fetchAll();
        return resources;
      },
      async put(collection, doc, version = null) {
        const value = { ...doc, collection }; delete value._etag; delete value._rid; delete value._self; delete value._attachments; delete value._ts;
        try {
          const { resource } = version
            ? await container.item(doc.id, collection).replace(value, { accessCondition: { type: 'IfMatch', condition: version } })
            : await container.items.create(value);
          return resource;
        } catch (e) { if ([409, 412].includes(e.code)) throw new Conflict('Concurrent update'); throw e; }
      },
      close() {},
    };
  }
  await mkdir(cfg.dataDir, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(cfg.dataDir, 'vibeq.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY (collection,id));');
  const decode = row => row ? { ...JSON.parse(row.body), _etag: row.version } : null;
  return {
    async get(collection, id) { return decode(db.prepare('SELECT body,version FROM documents WHERE collection=? AND id=?').get(collection, id)); },
    async list(collection) { return db.prepare('SELECT body,version FROM documents WHERE collection=?').all(collection).map(decode); },
    async put(collection, doc, version = null) {
      const next = randomUUID(), body = { ...doc }; delete body._etag;
      if (version) {
        const result = db.prepare('UPDATE documents SET body=?,version=? WHERE collection=? AND id=? AND version=?').run(JSON.stringify(body), next, collection, doc.id, version);
        if (!result.changes) throw new Conflict('Concurrent update');
      } else {
        try { db.prepare('INSERT INTO documents VALUES (?,?,?,?)').run(collection, doc.id, JSON.stringify(body), next); }
        catch (e) { if (e.code === 'ERR_SQLITE_ERROR' && e.message.includes('UNIQUE')) throw new Conflict('Concurrent update'); throw e; }
      }
      return { ...body, _etag: next };
    },
    close() { db.close(); },
  };
}
export async function update(store, collection, id, fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await store.get(collection, id);
    const next = await fn(before);
    if (!next) return before;
    try { return await store.put(collection, { ...next, id }, before?._etag); }
    catch (e) { if (!(e instanceof Conflict)) throw e; }
  }
  throw new Conflict('Busy; please retry.');
}
export async function withLease(store, id, work, duration = 120000) {
  const owner = randomUUID();
  let claimed = false;
  await update(store, 'locks', id, old => {
    if (old?.until > Date.now()) return null;
    claimed = true; return { id, owner, until: Date.now() + duration };
  });
  // A CAS retry can lose to another owner. Check the persisted owner.
  if (!claimed || (await store.get('locks', id))?.owner !== owner) return { busy: true };
  try { return await work(); }
  finally { await update(store, 'locks', id, old => old?.owner === owner ? { ...old, until: 0 } : null); }
}
