/**
 * Node.js v7.2.0 driver shim for the documentdb-driver-testing harness.
 *
 * Protocol
 * ────────
 * Reads one JSON line per message from stdin (harness → shim):
 *
 *   { "id": 1, "type": "connect",    "payload": { "uri": "mongodb://..." } }
 *   { "id": 2, "type": "operation",  "payload": { "name": "insertOne", ... } }
 *   { "id": 3, "type": "disconnect", "payload": {} }
 *
 * Writes one JSON line per response to stdout (shim → harness):
 *
 *   { "id": 1 }
 *   { "id": 2, "result": { "insertedId": "..." } }
 *   { "id": 2, "error": { "message": "...", "code": 11000 } }
 *
 * Diagnostic output goes to stderr.
 */

import { createInterface } from 'readline';
import { MongoClient, ClientSession } from 'mongodb';

// ── Wire types ────────────────────────────────────────────────────────────────

interface InboundMessage {
  id: number;
  type: 'connect' | 'disconnect' | 'operation';
  payload: Record<string, unknown>;
}

interface OutboundMessage {
  id: number;
  result?: unknown;
  error?: { message: string; code?: number; labels?: string[] };
}

interface Operation {
  name: string;
  object: string;
  database?: string;
  collection?: string;
  arguments?: Record<string, unknown>;
  saveResultAs?: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

let client: MongoClient | null = null;
const sessions = new Map<string, ClientSession>();

// ── Response helpers ─────────────────────────────────────────────────────────

function respond(msg: OutboundMessage): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id: number, result?: unknown): void {
  respond(result !== undefined ? { id, result } : { id });
}

function fail(id: number, err: unknown): void {
  const e = err as Record<string, unknown>;
  respond({
    id,
    error: {
      message: typeof e?.['message'] === 'string' ? e['message'] : String(err),
      ...(typeof e?.['code'] === 'number' ? { code: e['code'] as number } : {}),
      ...(Array.isArray(e?.['errorLabels'])
        ? { labels: e['errorLabels'] as string[] }
        : {}),
    },
  });
}

// ── Session resolution ────────────────────────────────────────────────────────

function resolveSessionArg(arg: unknown): ClientSession | undefined {
  if (arg !== null && typeof arg === 'object') {
    const key = (arg as Record<string, unknown>)['__sessionKey'];
    if (typeof key === 'string') return sessions.get(key);
  }
  return undefined;
}

function requireSession(key: string): ClientSession {
  const s = sessions.get(key);
  if (!s) throw new Error(`No session found with key "${key}"`);
  return s;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function dispatch(op: Operation): Promise<unknown> {
  if (!client) throw new Error('Not connected');

  const args = op.arguments ?? {};
  const sessionOpt = args['session'] !== undefined
    ? resolveSessionArg(args['session'])
    : undefined;

  switch (op.name) {
    // ── Session lifecycle ──────────────────────────────────────────────────

    case 'startSession': {
      const newSession = client.startSession(
        args as Parameters<MongoClient['startSession']>[0],
      );
      const key = op.saveResultAs ?? `session${sessions.size}`;
      sessions.set(key, newSession);
      return { __sessionKey: key, lsid: newSession.id };
    }

    case 'endSession': {
      const session = requireSession(op.object);
      await session.endSession();
      sessions.delete(op.object);
      return null;
    }

    // ── Transactions ───────────────────────────────────────────────────────

    case 'startTransaction': {
      const session = requireSession(op.object);
      session.startTransaction(
        args as Parameters<ClientSession['startTransaction']>[0],
      );
      return null;
    }

    case 'commitTransaction': {
      const session = requireSession(op.object);
      await session.commitTransaction();
      return null;
    }

    case 'abortTransaction': {
      const session = requireSession(op.object);
      await session.abortTransaction();
      return null;
    }

    // ── Collection CRUD ────────────────────────────────────────────────────

    case 'insertOne': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.insertOne(args['document'] as object, { session: sessionOpt });
    }

    case 'insertMany': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.insertMany(args['documents'] as object[], { session: sessionOpt });
    }

    case 'findOne': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.findOne((args['filter'] ?? {}) as object, { session: sessionOpt });
    }

    case 'find': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll
        .find((args['filter'] ?? {}) as object, { session: sessionOpt })
        .toArray();
    }

    case 'updateOne': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.updateOne(
        args['filter'] as object,
        args['update'] as object,
        { session: sessionOpt },
      );
    }

    case 'updateMany': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.updateMany(
        args['filter'] as object,
        args['update'] as object,
        { session: sessionOpt },
      );
    }

    case 'replaceOne': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.replaceOne(
        args['filter'] as object,
        args['replacement'] as object,
        { session: sessionOpt },
      );
    }

    case 'deleteOne': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.deleteOne((args['filter'] ?? {}) as object, { session: sessionOpt });
    }

    case 'deleteMany': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.deleteMany((args['filter'] ?? {}) as object, { session: sessionOpt });
    }

    case 'countDocuments': {
      const coll = client.db(op.database!).collection(op.collection!);
      return coll.countDocuments(
        (args['filter'] ?? {}) as object,
        { session: sessionOpt },
      );
    }

    case 'aggregate': {
      const db = client.db(op.database!);
      const pipeline = args['pipeline'] as object[];
      const cursor = op.collection
        ? db.collection(op.collection).aggregate(pipeline, { session: sessionOpt })
        : db.aggregate(pipeline, { session: sessionOpt });
      return cursor.toArray();
    }

    // ── Database / admin ───────────────────────────────────────────────────

    case 'runCommand': {
      return client
        .db(op.database!)
        .command(args['command'] as object, { session: sessionOpt });
    }

    case 'listCollections': {
      return client
        .db(op.database!)
        .listCollections({}, { session: sessionOpt })
        .toArray();
    }

    case 'createCollection': {
      return client
        .db(op.database!)
        .createCollection(args['collection'] as string, { session: sessionOpt });
    }

    case 'dropCollection': {
      const collName = (op.collection ?? args['collection']) as string;
      return client
        .db(op.database!)
        .dropCollection(collName, { session: sessionOpt });
    }

    case 'listDatabases': {
      return client.db().admin().listDatabases();
    }

    default:
      throw new Error(`Unsupported operation: ${op.name}`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  void (async () => {
    let msg: InboundMessage;
    try {
      msg = JSON.parse(line) as InboundMessage;
    } catch {
      process.stderr.write(`shim: failed to parse message: ${line}\n`);
      return;
    }

    try {
      if (msg.type === 'connect') {
        const uri = msg.payload['uri'] as string;
        const opts = msg.payload['options'] as Record<string, unknown> | undefined ?? {};
        const { serverSelectionTimeoutMS, directConnection, ...rest } = opts;
        client = new MongoClient(uri, {
          ...(typeof serverSelectionTimeoutMS === 'number' ? { serverSelectionTimeoutMS } : {}),
          ...(typeof directConnection === 'boolean' ? { directConnection } : {}),
          ...rest,
        });
        await client.connect();
        ok(msg.id);
      } else if (msg.type === 'disconnect') {
        for (const s of sessions.values()) await s.endSession().catch(() => {});
        sessions.clear();
        await client?.close();
        client = null;
        ok(msg.id);
      } else if (msg.type === 'operation') {
        const result = await dispatch(msg.payload as unknown as Operation);
        ok(msg.id, result ?? null);
      } else {
        fail(msg.id, new Error(`Unknown message type: ${msg.type}`));
      }
    } catch (err) {
      fail(msg.id, err);
    }
  })();
});

