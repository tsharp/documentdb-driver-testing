import { MongoClient, ClientSession } from 'mongodb';
import type { DriverAdapter } from '../../src/protocol/DriverAdapter';
import type { ConnectOptions, Operation, OperationResult } from '../../src/protocol/types';

/**
 * In-process adapter for the official Node.js MongoDB driver.
 *
 * Session handling
 * ────────────────
 * When `startSession` runs with `saveResultAs: "session0"`, the adapter stores
 * the live `ClientSession` under that key internally and returns:
 *
 *   { __sessionKey: "session0", lsid: session.id }
 *
 * The `__sessionKey` marker lets subsequent operations pass the resolved
 * `$$session0` value back through `arguments.session`; the adapter detects the
 * marker and substitutes the live `ClientSession` object before calling the
 * driver.  The `lsid` field allows YAML assertions like
 * `expectResult: { lsid: { $$exists: true } }` to work against the stored value.
 */
export class NodejsDriverAdapter implements DriverAdapter {
  readonly name = 'nodejs';
  readonly language = 'typescript';

  private client!: MongoClient;
  private sessions = new Map<string, ClientSession>();

  async connect(uri: string, options?: ConnectOptions): Promise<void> {
    const { serverSelectionTimeoutMS, directConnection, ...rest } = options ?? {};
    this.client = new MongoClient(uri, {
      ...(serverSelectionTimeoutMS !== undefined && { serverSelectionTimeoutMS }),
      ...(directConnection !== undefined && { directConnection }),
      ...rest,
    });
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.cleanupTestState();
    await this.client.close();
  }

  async cleanupTestState(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.endSession().catch(() => {});
    }
    this.sessions.clear();
  }

  async runOperation(op: Operation): Promise<OperationResult> {
    try {
      const result = await this.dispatch(op);
      return { result };
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      return {
        error: {
          message: typeof e?.['message'] === 'string' ? e['message'] : String(err),
          code: typeof e?.['code'] === 'number' ? e['code'] : undefined,
          labels: Array.isArray(e?.['errorLabels'])
            ? (e['errorLabels'] as string[])
            : undefined,
        },
      };
    }
  }

  // ── Session resolution ────────────────────────────────────────────────────

  /**
   * Resolve a resolved `$$var` argument value back to a live ClientSession.
   * Accepts the `{ __sessionKey, lsid }` marker object returned by startSession.
   */
  private resolveSessionArg(arg: unknown): ClientSession | undefined {
    if (arg !== null && typeof arg === 'object') {
      const key = (arg as Record<string, unknown>)['__sessionKey'];
      if (typeof key === 'string') {
        return this.sessions.get(key);
      }
    }
    return undefined;
  }

  /** Returns the session stored under `op.object` (for session-centric ops). */
  private requireSession(object: string): ClientSession {
    const session = this.sessions.get(object);
    if (!session) throw new Error(`No session found with key "${object}"`);
    return session;
  }

  // ── Dispatcher ────────────────────────────────────────────────────────────

  private async dispatch(op: Operation): Promise<unknown> {
    const args = op.arguments ?? {};
    // Resolve an optional session passed as arguments.session: $$sessionN
    const sessionOpt = args['session'] !== undefined
      ? this.resolveSessionArg(args['session'])
      : undefined;

    switch (op.name) {
      // ── Session lifecycle ──────────────────────────────────────────────

      case 'startSession': {
        const newSession = this.client.startSession(
          args as Parameters<MongoClient['startSession']>[0],
        );
        const key = op.saveResultAs ?? `session${this.sessions.size}`;
        this.sessions.set(key, newSession);
        return { __sessionKey: key, lsid: newSession.id };
      }

      case 'endSession': {
        const session = this.requireSession(op.object);
        await session.endSession();
        this.sessions.delete(op.object);
        return null;
      }

      // ── Transactions ───────────────────────────────────────────────────

      case 'startTransaction': {
        const session = this.requireSession(op.object);
        session.startTransaction(
          args as Parameters<ClientSession['startTransaction']>[0],
        );
        return null;
      }

      case 'commitTransaction': {
        const session = this.requireSession(op.object);
        await session.commitTransaction();
        return null;
      }

      case 'abortTransaction': {
        const session = this.requireSession(op.object);
        await session.abortTransaction();
        return null;
      }

      // ── Collection CRUD ────────────────────────────────────────────────

      case 'insertOne': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.insertOne(args['document'] as object, { session: sessionOpt });
      }

      case 'insertMany': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.insertMany(args['documents'] as object[], { session: sessionOpt });
      }

      case 'findOne': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.findOne((args['filter'] ?? {}) as object, { session: sessionOpt });
      }

      case 'find': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll
          .find((args['filter'] ?? {}) as object, { session: sessionOpt })
          .toArray();
      }

      case 'updateOne': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.updateOne(
          args['filter'] as object,
          args['update'] as object,
          { session: sessionOpt },
        );
      }

      case 'updateMany': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.updateMany(
          args['filter'] as object,
          args['update'] as object,
          { session: sessionOpt },
        );
      }

      case 'replaceOne': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.replaceOne(
          args['filter'] as object,
          args['replacement'] as object,
          { session: sessionOpt },
        );
      }

      case 'deleteOne': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.deleteOne((args['filter'] ?? {}) as object, { session: sessionOpt });
      }

      case 'deleteMany': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.deleteMany((args['filter'] ?? {}) as object, { session: sessionOpt });
      }

      case 'countDocuments': {
        const coll = this.client.db(op.database!).collection(op.collection!);
        return coll.countDocuments(
          (args['filter'] ?? {}) as object,
          { session: sessionOpt },
        );
      }

      case 'aggregate': {
        const db = this.client.db(op.database!);
        const pipeline = args['pipeline'] as object[];
        const cursor = op.collection
          ? db.collection(op.collection).aggregate(pipeline, { session: sessionOpt })
          : db.aggregate(pipeline, { session: sessionOpt });
        return cursor.toArray();
      }

      // ── Database / admin ───────────────────────────────────────────────

      case 'runCommand': {
        return this.client
          .db(op.database!)
          .command(args['command'] as object, { session: sessionOpt });
      }

      case 'listCollections': {
        return this.client
          .db(op.database!)
          .listCollections({}, { session: sessionOpt })
          .toArray();
      }

      case 'createCollection': {
        return this.client
          .db(op.database!)
          .createCollection(args['collection'] as string, { session: sessionOpt });
      }

      case 'dropCollection': {
        const collName = (op.collection ?? args['collection']) as string;
        return this.client
          .db(op.database!)
          .dropCollection(collName, { session: sessionOpt });
      }

      case 'listDatabases': {
        return this.client.db().admin().listDatabases();
      }

      default:
        throw new Error(`Unsupported operation: "${op.name}"`);
    }
  }
}
