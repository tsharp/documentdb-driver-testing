import { createRequire } from 'module';
import { resolve } from 'path';
import { createInterface } from 'readline';

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

const localRequire = createRequire(resolve(process.cwd(), 'package.json'));
const mongoose = localRequire('mongoose');

let connection: any = null;
const sessions = new Map<string, any>();
const models = new Map<string, any>();

function respond(message: OutboundMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id: number, result?: unknown): void {
  respond(result !== undefined ? { id, result } : { id });
}

function fail(id: number, error: unknown): void {
  const value = error as Record<string, unknown>;
  respond({
    id,
    error: {
      message: typeof value?.['message'] === 'string' ? value['message'] : String(error),
      ...(typeof value?.['code'] === 'number' ? { code: value['code'] } : {}),
      ...(Array.isArray(value?.['errorLabels'])
        ? { labels: value['errorLabels'] as string[] }
        : {}),
    },
  });
}

function requireConnection(): any {
  if (!connection) throw new Error('Not connected');
  return connection;
}

function getDatabase(name: string): any {
  return requireConnection().useDb(name, { useCache: true });
}

function getModel(database: string, collection: string): any {
  const key = `${database}\0${collection}`;
  const existing = models.get(key);
  if (existing) return existing;

  const schema = new mongoose.Schema(
    {
      _id: {
        type: mongoose.Schema.Types.Mixed,
        default: () => new mongoose.Types.ObjectId(),
      },
    },
    {
      strict: false,
      strictQuery: false,
      versionKey: false,
      minimize: false,
      autoCreate: false,
      autoIndex: false,
    },
  );
  const model = getDatabase(database).model(
    `HarnessModel${models.size}`,
    schema,
    collection,
  );
  models.set(key, model);
  return model;
}

function resolveSessionArg(argument: unknown): any | undefined {
  if (argument !== null && typeof argument === 'object') {
    const key = (argument as Record<string, unknown>)['__sessionKey'];
    if (typeof key === 'string') return sessions.get(key);
  }
  return undefined;
}

function requireSession(key: string): any {
  const session = sessions.get(key);
  if (!session) throw new Error(`No session found with key "${key}"`);
  return session;
}

function normalizedUpdateResult(result: any): Record<string, unknown> {
  const upsertedId = result.upsertedId ?? result.upserted?.[0]?._id;
  return {
    acknowledged: result.acknowledged ?? result.ok === 1,
    matchedCount: upsertedId != null ? 0 : (result.matchedCount ?? result.n ?? 0),
    modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
    ...(upsertedId != null ? { upsertedId } : {}),
  };
}

function normalizedDeleteResult(result: any): Record<string, unknown> {
  return {
    acknowledged: result.acknowledged ?? result.ok === 1,
    deletedCount: result.deletedCount ?? result.n ?? 0,
  };
}

function normalizedBulkResult(result: any): Record<string, unknown> {
  return {
    acknowledged: result.acknowledged ?? result.ok === 1,
    insertedCount: result.insertedCount ?? result.nInserted ?? 0,
    matchedCount: result.matchedCount ?? result.nMatched ?? 0,
    modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
    deletedCount: result.deletedCount ?? result.nRemoved ?? 0,
    upsertedCount: result.upsertedCount ?? result.nUpserted ?? 0,
    ...(result.insertedIds !== undefined ? { insertedIds: result.insertedIds } : {}),
    ...(result.upsertedIds !== undefined ? { upsertedIds: result.upsertedIds } : {}),
  };
}

function requireAtomicUpdate(update: unknown): void {
  if (
    update !== null &&
    typeof update === 'object' &&
    !Array.isArray(update) &&
    !Object.keys(update as object).some((path) => path.startsWith('$'))
  ) {
    throw new Error('Update document requires atomic operators');
  }
}

function registerArrayPaths(Model: any, documents: unknown[]): void {
  const paths: Record<string, unknown> = {};
  for (const document of documents) {
    if (document === null || typeof document !== 'object') continue;
    for (const [path, value] of Object.entries(document as Record<string, unknown>)) {
      if (Array.isArray(value) && !Model.schema.path(path)) {
        paths[path] = [mongoose.Schema.Types.Mixed];
      }
    }
  }
  if (Object.keys(paths).length > 0) Model.schema.add(paths);
}

function registerArrayUpdatePaths(Model: any, update: unknown): void {
  if (update === null || typeof update !== 'object') return;
  const value = update as Record<string, unknown>;
  for (const operator of ['$push', '$addToSet', '$pull', '$pop']) {
    const updates = value[operator];
    if (updates !== null && typeof updates === 'object') {
      registerArrayPaths(
        Model,
        [Object.fromEntries(Object.keys(updates as object).map((path) => [path, []]))],
      );
    }
  }
}

async function validateBulkRequests(Model: any, requests: any[]): Promise<void> {
  for (const request of requests) {
    const document = request.insertOne?.document ?? request.replaceOne?.replacement;
    if (document !== undefined) {
      registerArrayPaths(Model, [document]);
      await new Model(document).validate();
    }
    const update = request.updateOne?.update ?? request.updateMany?.update;
    if (update !== undefined) registerArrayUpdatePaths(Model, update);
  }
}

async function dispatch(operation: Operation): Promise<unknown> {
  const activeConnection = requireConnection();
  const args = operation.arguments ?? {};
  const session = args['session'] !== undefined
    ? resolveSessionArg(args['session'])
    : undefined;

  switch (operation.name) {
    case 'startSession': {
      const newSession = await activeConnection.startSession(args);
      const key = operation.saveResultAs ?? `session${sessions.size}`;
      sessions.set(key, newSession);
      return { __sessionKey: key, lsid: newSession.id };
    }
    case 'endSession': {
      const activeSession = requireSession(operation.object);
      await activeSession.endSession();
      sessions.delete(operation.object);
      return null;
    }
    case 'startTransaction':
      requireSession(operation.object).startTransaction(args);
      return null;
    case 'commitTransaction':
      await requireSession(operation.object).commitTransaction();
      return null;
    case 'abortTransaction':
      await requireSession(operation.object).abortTransaction();
      return null;
  }

  const database = operation.database!;
  const collection = operation.collection!;
  const Model = collection ? getModel(database, collection) : undefined;

  switch (operation.name) {
    case 'insertOne': {
      registerArrayPaths(Model, [args['document']]);
      const document = new Model(args['document']);
      await document.validate();
      await document.save({ session });
      return { acknowledged: true, insertedId: document._id };
    }
    case 'insertMany': {
      registerArrayPaths(Model, args['documents'] as unknown[]);
      const documents = await Model.insertMany(args['documents'], {
        session,
        ordered: args['ordered'] !== false,
      });
      return {
        acknowledged: true,
        insertedCount: documents.length,
        insertedIds: Object.fromEntries(
          documents.map((document: any, index: number) => [index, document._id]),
        ),
      };
    }
    case 'findOne':
      return Model.findOne(args['filter'] ?? {}, args['projection'] ?? null, { session })
        .lean()
        .exec();
    case 'find': {
      let query = Model.find(args['filter'] ?? {}, args['projection'] ?? null, { session });
      if (args['sort']) query = query.sort(args['sort']);
      if (typeof args['skip'] === 'number') query = query.skip(args['skip']);
      if (typeof args['limit'] === 'number') query = query.limit(args['limit']);
      return query.lean().exec();
    }
    case 'findOneAndUpdate':
      requireAtomicUpdate(args['update']);
      registerArrayUpdatePaths(Model, args['update']);
      return Model.findOneAndUpdate(args['filter'], args['update'], {
        session,
        new: args['returnDocument'] === 'after',
        upsert: args['upsert'] === true,
        runValidators: true,
        strict: false,
        ...(args['sort'] ? { sort: args['sort'] } : {}),
        ...(args['projection'] ? { projection: args['projection'] } : {}),
      }).lean().exec();
    case 'findOneAndDelete':
      return Model.findOneAndDelete(args['filter'], {
        session,
        ...(args['sort'] ? { sort: args['sort'] } : {}),
        ...(args['projection'] ? { projection: args['projection'] } : {}),
      }).lean().exec();
    case 'findOneAndReplace': {
      await new Model(args['replacement']).validate();
      return Model.findOneAndReplace(args['filter'], args['replacement'], {
        session,
        new: args['returnDocument'] === 'after',
        upsert: args['upsert'] === true,
        runValidators: true,
        strict: false,
        ...(args['projection'] ? { projection: args['projection'] } : {}),
      }).lean().exec();
    }
    case 'updateOne':
      requireAtomicUpdate(args['update']);
      registerArrayUpdatePaths(Model, args['update']);
      return normalizedUpdateResult(await Model.updateOne(args['filter'], args['update'], {
        session,
        upsert: args['upsert'] === true,
        runValidators: true,
        strict: false,
      }).exec());
    case 'updateMany':
      requireAtomicUpdate(args['update']);
      registerArrayUpdatePaths(Model, args['update']);
      return normalizedUpdateResult(await Model.updateMany(args['filter'], args['update'], {
        session,
        upsert: args['upsert'] === true,
        runValidators: true,
        strict: false,
      }).exec());
    case 'replaceOne': {
      await new Model(args['replacement']).validate();
      const result = await Model.replaceOne(args['filter'], args['replacement'], {
        session,
        upsert: args['upsert'] === true,
        runValidators: true,
        strict: false,
      }).exec();
      return normalizedUpdateResult(result);
    }
    case 'deleteOne':
      return normalizedDeleteResult(await Model.deleteOne(args['filter'] ?? {}, { session }).exec());
    case 'deleteMany':
      return normalizedDeleteResult(await Model.deleteMany(args['filter'] ?? {}, { session }).exec());
    case 'countDocuments': {
      const query = Model.countDocuments(args['filter'] ?? {});
      if (session) query.session(session);
      return query.exec();
    }
    case 'aggregate': {
      if (!collection) {
        return getDatabase(database).db.aggregate(args['pipeline'], { session }).toArray();
      }
      const aggregate = Model.aggregate(args['pipeline']);
      if (session) aggregate.session(session);
      return aggregate.exec();
    }
    case 'distinct': {
      const query = Model.distinct(args['field'], args['filter'] ?? {});
      if (session) query.session(session);
      return query.exec();
    }
    case 'bulkWrite': {
      const requests = args['requests'] as any[];
      await validateBulkRequests(Model, requests);
      const result = await Model.bulkWrite(requests, {
        ordered: args['ordered'] !== false,
        session,
      });
      return normalizedBulkResult(result);
    }
    case 'createIndex':
      return Model.collection.createIndex(args['keys'], { ...(args['options'] as object ?? {}), session });
    case 'dropIndex':
      return Model.collection.dropIndex(args['name'], { session });
    case 'listIndexes':
      return Model.collection.listIndexes().toArray();
    case 'runCommand':
      return getDatabase(database).db.command(args['command'], { session });
    case 'listCollections':
      return getDatabase(database).db.listCollections({}, { session }).toArray();
    case 'createCollection':
      return getDatabase(database).db.createCollection(args['collection'], { session });
    case 'dropCollection':
      return getDatabase(database).db.dropCollection(collection ?? args['collection'], { session });
    case 'listDatabases': {
      const client = activeConnection.client ?? activeConnection.db?.s?.client;
      if (!client) throw new Error('Unable to access the underlying MongoDB client');
      return client.db().admin().listDatabases();
    }
    default:
      throw new Error(`Unsupported operation: ${operation.name}`);
  }
}

async function connect(uri: string, options: Record<string, unknown>): Promise<void> {
  connection = mongoose.createConnection(uri, options);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    if (connection.readyState === 1) {
      resolveOpen();
      return;
    }
    connection.once('open', resolveOpen);
    connection.once('error', rejectOpen);
  });
}

async function disconnect(): Promise<void> {
  for (const session of sessions.values()) await session.endSession().catch(() => {});
  sessions.clear();
  models.clear();
  await connection?.close();
  connection = null;
}

const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', (line: string) => {
  void (async () => {
    let message: InboundMessage;
    try {
      message = JSON.parse(line) as InboundMessage;
    } catch {
      process.stderr.write(`shim: failed to parse message: ${line}\n`);
      return;
    }

    try {
      if (message.type === 'connect') {
        await connect(
          message.payload['uri'] as string,
          (message.payload['options'] as Record<string, unknown> | undefined) ?? {},
        );
        ok(message.id);
      } else if (message.type === 'disconnect') {
        await disconnect();
        ok(message.id);
      } else if (message.type === 'operation') {
        ok(message.id, (await dispatch(message.payload as unknown as Operation)) ?? null);
      } else {
        fail(message.id, new Error(`Unknown message type: ${message.type}`));
      }
    } catch (error) {
      fail(message.id, error);
    }
  })();
});