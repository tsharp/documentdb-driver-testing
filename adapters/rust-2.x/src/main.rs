//! Rust shim for the documentdb-driver-testing harness.
//!
//! Protocol
//! ────────
//! Reads one JSON line per message from **stdin** (harness → shim):
//!
//!   { "id": 1, "type": "connect",    "payload": { "uri": "mongodb://..." } }
//!   { "id": 2, "type": "operation",  "payload": { "name": "insertOne", ... } }
//!   { "id": 3, "type": "disconnect", "payload": {} }
//!
//! Writes one JSON line per response to **stdout** (shim → harness):
//!
//!   { "id": 1 }                                        -- success, null result
//!   { "id": 2, "result": { "insertedId": "..." } }    -- success with result
//!   { "id": 2, "error": { "message": "..." } }        -- driver error
//!
//! Diagnostic output goes to **stderr** (the harness passes it through).
//!
//! Session handling
//! ────────────────
//! `startSession` stores the live `ClientSession` in a map keyed by
//! `saveResultAs` (or a generated name) and returns:
//!
//!   { "__sessionKey": "session0", "lsid": { "id": <Binary> } }
//!
//! Later operations that carry `arguments.session = { "__sessionKey": "session0" }`
//! have the session resolved before the driver call.

use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::sync::Arc;

use bson::{doc, Document};
use mongodb::{
    Client, ClientSession, Collection, IndexModel,    error::ErrorKind,    options::{
        ClientOptions, FindOptions, FindOneAndUpdateOptions, FindOneAndDeleteOptions,
        FindOneAndReplaceOptions, ReturnDocument, UpdateOptions, ReplaceOptions, IndexOptions,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

// ── Wire protocol types ───────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct InboundMessage {
    id: u64,
    #[serde(rename = "type")]
    msg_type: String,
    payload: Value,
}

#[derive(Serialize)]
struct OutboundMessage {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ShimError>,
}

#[derive(Serialize)]
struct ShimError {
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    labels: Option<Vec<String>>,
}

// ── Dispatch error (carries code for write/command errors) ────────────────────

struct DispatchError {
    message: String,
    code: Option<i32>,
}

impl From<String> for DispatchError {
    fn from(s: String) -> Self { DispatchError { message: s, code: None } }
}

impl From<&str> for DispatchError {
    fn from(s: &str) -> Self { DispatchError { message: s.to_string(), code: None } }
}

/// Convert a mongodb driver error into a `DispatchError`, extracting write/
/// command error codes where available.
fn mongo_err(e: mongodb::error::Error) -> DispatchError {
    use mongodb::error::WriteFailure;
    let code: Option<i32> = match e.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(we)) => Some(we.code),
        ErrorKind::BulkWrite(bw) => bw.write_errors.as_ref()
            .and_then(|v| v.first())
            .map(|we| we.code),
        ErrorKind::Command(ce) => Some(ce.code),
        _ => None,
    };
    let message = match e.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(we)) => we.message.clone(),
        ErrorKind::BulkWrite(bw) => bw.write_errors.as_ref()
            .and_then(|v| v.first())
            .map(|we| we.message.clone())
            .unwrap_or_else(|| e.kind.to_string()),
        ErrorKind::Command(ce) => ce.message.clone(),
        _ => e.to_string(),
    };
    DispatchError { message, code }
}

// ── Operation payload (mirrors types.ts) ──────────────────────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Operation {
    name: String,
    object: String,
    database: Option<String>,
    collection: Option<String>,
    #[serde(default)]
    arguments: Value,
    save_result_as: Option<String>,
}

// ── Shim state ────────────────────────────────────────────────────────────────

struct ShimState {
    client: Option<Client>,
    /// Live sessions keyed by their `saveResultAs` / generated name.
    sessions: HashMap<String, ClientSession>,
    session_counter: usize,
}

impl ShimState {
    fn new() -> Self {
        Self {
            client: None,
            sessions: HashMap::new(),
            session_counter: 0,
        }
    }

    fn client(&self) -> Result<&Client, DispatchError> {
        self.client.as_ref().ok_or_else(|| DispatchError::from("Not connected"))
    }

    fn require_session(&mut self, key: &str) -> Result<&mut ClientSession, DispatchError> {
        self.sessions
            .get_mut(key)
            .ok_or_else(|| DispatchError::from(format!("No session with key \"{}\"", key).as_str()))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Convert a `serde_json::Value` to a BSON `Document`.
/// Integers that fit in i32 are encoded as Int32 (BSON type 16), matching
/// the behaviour of the Node.js BSON library and enabling `$type: "int"`.
fn json_to_bson(v: &Value) -> bson::Bson {
    match v {
        Value::Null        => bson::Bson::Null,
        Value::Bool(b)     => bson::Bson::Boolean(*b),
        Value::String(s)   => bson::Bson::String(s.clone()),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if i >= i32::MIN as i64 && i <= i32::MAX as i64 {
                    bson::Bson::Int32(i as i32)
                } else {
                    bson::Bson::Int64(i)
                }
            } else {
                bson::Bson::Double(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::Array(arr)  => bson::Bson::Array(arr.iter().map(json_to_bson).collect()),
        Value::Object(obj) => {
            let mut doc = Document::new();
            for (k, v) in obj { doc.insert(k.clone(), json_to_bson(v)); }
            bson::Bson::Document(doc)
        }
    }
}

fn value_to_doc(v: &Value) -> Result<Document, String> {
    match json_to_bson(v) {
        bson::Bson::Document(d) => Ok(d),
        other => Err(format!("Expected document, got {:?}", other)),
    }
}

/// Convert any BSON-serialisable value back to a `serde_json::Value`.
fn bson_to_value<T: serde::Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

/// If `arguments.session` contains a `__sessionKey` marker, return that key.
fn session_key_from_args(args: &Value) -> Option<String> {
    args.get("session")
        .and_then(|s| s.get("__sessionKey"))
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
}

fn collection<'a>(client: &'a Client, db: &Option<String>, coll: &Option<String>) -> Result<Collection<Document>, String> {
    let db = db.as_deref().ok_or("Missing database")?;
    let coll = coll.as_deref().ok_or("Missing collection")?;
    Ok(client.database(db).collection::<Document>(coll))
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async fn dispatch(state: &mut ShimState, op: Operation) -> Result<Value, DispatchError> {
    let args = &op.arguments;
    let session_key = session_key_from_args(args);

    match op.name.as_str() {
        // ── Connection ─────────────────────────────────────────────────────
        // (handled in the main loop, not here)

        // ── Session lifecycle ──────────────────────────────────────────────
        "startSession" => {
            let client = state.client()?.clone();
            let session = client
                .start_session(None)
                .await
                .map_err(mongo_err)?;
            let lsid = session.id().clone();
            let key = op.save_result_as
                .clone()
                .unwrap_or_else(|| {
                    let k = format!("session{}", state.session_counter);
                    state.session_counter += 1;
                    k
                });
            state.sessions.insert(key.clone(), session);
            Ok(serde_json::json!({
                "__sessionKey": key,
                "lsid": bson_to_value(&lsid),
            }))
        }

        "endSession" => {
            let key = &op.object;
            let mut session = state.sessions.remove(key)
                .ok_or_else(|| format!("No session with key \"{}\"", key))?;
            session.abort_transaction().await.ok(); // best-effort
            Ok(Value::Null)
        }

        // ── Transactions ───────────────────────────────────────────────────
        "startTransaction" => {
            let session = state.require_session(&op.object)?;
            session.start_transaction(None).await.map_err(mongo_err)?;
            Ok(Value::Null)
        }

        "commitTransaction" => {
            let session = state.require_session(&op.object)?;
            session.commit_transaction().await.map_err(mongo_err)?;
            Ok(Value::Null)
        }

        "abortTransaction" => {
            let session = state.require_session(&op.object)?;
            session.abort_transaction().await.map_err(mongo_err)?;
            Ok(Value::Null)
        }

        // ── insertOne ──────────────────────────────────────────────────────
        "insertOne" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let doc = value_to_doc(args.get("document").unwrap_or(&Value::Null))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.insert_one_with_session(doc, None, session).await
            } else {
                coll.insert_one(doc, None).await
            }.map_err(mongo_err)?;
            Ok(serde_json::json!({
                "acknowledged": true,
                "insertedId": bson_to_value(&result.inserted_id),
            }))
        }

        // ── insertMany ─────────────────────────────────────────────────────
        "insertMany" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let docs: Vec<Document> = args
                .get("documents")
                .and_then(|v| v.as_array())
                .ok_or("Missing documents array")?
                .iter()
                .map(value_to_doc)
                .collect::<Result<_, _>>()?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.insert_many_with_session(docs, None, session).await
            } else {
                coll.insert_many(docs, None).await
            }.map_err(mongo_err)?;
            let ids: serde_json::Map<String, Value> = result
                .inserted_ids
                .iter()
                .map(|(i, v)| (i.to_string(), bson_to_value(v)))
                .collect();
            Ok(serde_json::json!({ "acknowledged": true, "insertedIds": ids }))
        }

        // ── findOne ────────────────────────────────────────────────────────
        "findOne" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.find_one_with_session(filter, None, session).await
            } else {
                coll.find_one(filter, None).await
            }.map_err(mongo_err)?;
            Ok(result.map(|d| bson_to_value(&d)).unwrap_or(Value::Null))
        }

        // ── find (with options) ─────────────────────────────────────────────
        "find" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            let mut opts = FindOptions::default();
            if let Some(sort) = args.get("sort") { opts.sort = Some(value_to_doc(sort)?); }
            if let Some(proj) = args.get("projection") { opts.projection = Some(value_to_doc(proj)?); }
            if let Some(skip) = args.get("skip").and_then(|v| v.as_i64()) { opts.skip = Some(skip as u64); }
            if let Some(limit) = args.get("limit").and_then(|v| v.as_i64()) { opts.limit = Some(limit); }
            use futures_util::TryStreamExt;
            let docs: Vec<Document> = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.find_with_session(filter, opts, session)
                    .await
                    .map_err(mongo_err)?
                    .stream(session)
                    .try_collect()
                    .await
                    .map_err(|e: mongodb::error::Error| e.to_string())?
            } else {
                coll.find(filter, opts)
                    .await
                    .map_err(mongo_err)?
                    .try_collect()
                    .await
                    .map_err(mongo_err)?
            };
            Ok(bson_to_value(&docs))
        }

        // ── updateOne ──────────────────────────────────────────────────────
        "updateOne" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Null))?;
            let update = value_to_doc(args.get("update").unwrap_or(&Value::Null))?;
            let upsert = args.get("upsert").and_then(|v| v.as_bool()).unwrap_or(false);
            let opts = if upsert { Some(UpdateOptions::builder().upsert(true).build()) } else { None };
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.update_one_with_session(filter, update, opts, session).await
            } else {
                coll.update_one(filter, update, opts).await
            }.map_err(mongo_err)?;
            let mut r = serde_json::json!({
                "acknowledged": true,
                "matchedCount":  result.matched_count,
                "modifiedCount": result.modified_count,
            });
            if let Some(id) = result.upserted_id {
                r["upsertedId"] = bson_to_value(&id);
            }
            Ok(r)
        }

        // ── updateMany ─────────────────────────────────────────────────────
        "updateMany" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Null))?;
            let update = value_to_doc(args.get("update").unwrap_or(&Value::Null))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.update_many_with_session(filter, update, None, session).await
            } else {
                coll.update_many(filter, update, None).await
            }.map_err(mongo_err)?;
            Ok(serde_json::json!({
                "acknowledged": true,
                "matchedCount":  result.matched_count,
                "modifiedCount": result.modified_count,
            }))
        }

        // ── replaceOne ─────────────────────────────────────────────────────
        "replaceOne" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter      = value_to_doc(args.get("filter").unwrap_or(&Value::Null))?;
            let replacement = value_to_doc(args.get("replacement").unwrap_or(&Value::Null))?;
            let upsert = args.get("upsert").and_then(|v| v.as_bool()).unwrap_or(false);
            let opts = if upsert { Some(ReplaceOptions::builder().upsert(true).build()) } else { None };
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.replace_one_with_session(filter, replacement, opts, session).await
            } else {
                coll.replace_one(filter, replacement, opts).await
            }.map_err(mongo_err)?;
            let mut r = serde_json::json!({
                "acknowledged": true,
                "matchedCount":  result.matched_count,
                "modifiedCount": result.modified_count,
            });
            if let Some(id) = result.upserted_id {
                r["upsertedId"] = bson_to_value(&id);
            }
            Ok(r)
        }

        // ── deleteOne ──────────────────────────────────────────────────────
        "deleteOne" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.delete_one_with_session(filter, None, session).await
            } else {
                coll.delete_one(filter, None).await
            }.map_err(mongo_err)?;
            Ok(serde_json::json!({ "acknowledged": true, "deletedCount": result.deleted_count }))
        }

        // ── deleteMany ─────────────────────────────────────────────────────
        "deleteMany" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.delete_many_with_session(filter, None, session).await
            } else {
                coll.delete_many(filter, None).await
            }.map_err(mongo_err)?;
            Ok(serde_json::json!({ "acknowledged": true, "deletedCount": result.deleted_count }))
        }

        // ── countDocuments ─────────────────────────────────────────────────
        "countDocuments" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            let n = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.count_documents_with_session(filter, None, session).await
            } else {
                coll.count_documents(filter, None).await
            }.map_err(mongo_err)?;
            Ok(Value::Number(n.into()))
        }

        // ── aggregate ──────────────────────────────────────────────────────
        "aggregate" => {
            let pipeline: Vec<Document> = args
                .get("pipeline")
                .and_then(|v| v.as_array())
                .ok_or("Missing pipeline array")?
                .iter()
                .map(value_to_doc)
                .collect::<Result<_, _>>()?;

            let client = state.client()?;
            let db_name = op.database.as_deref().ok_or("Missing database")?;

            use futures_util::TryStreamExt;
            let docs: Vec<Document> = match op.collection.as_deref() {
                Some(coll_name) => {
                    let coll = client.database(db_name).collection::<Document>(coll_name);
                    if let Some(ref key) = session_key {
                        let session = state.require_session(key)?;
                        coll.aggregate_with_session(pipeline, None, session).await
                            .map_err(mongo_err)?
                            .stream(session)
                            .try_collect()
                            .await
                            .map_err(|e: mongodb::error::Error| e.to_string())?
                    } else {
                        coll.aggregate(pipeline, None).await
                            .map_err(mongo_err)?
                            .try_collect()
                            .await
                            .map_err(mongo_err)?
                    }
                }
                None => {
                    let db = client.database(db_name);
                    db.aggregate(pipeline, None).await
                        .map_err(mongo_err)?
                        .try_collect()
                        .await
                        .map_err(mongo_err)?
                }
            };
            Ok(bson_to_value(&docs))
        }

        // ── findOneAndUpdate ───────────────────────────────────────────────
        "findOneAndUpdate" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Null))?;
            let update = value_to_doc(args.get("update").unwrap_or(&Value::Null))?;
            let return_after = args.get("returnDocument").and_then(|v| v.as_str()) == Some("after");
            let upsert = args.get("upsert").and_then(|v| v.as_bool()).unwrap_or(false);
            let opts = FindOneAndUpdateOptions::builder()
                .return_document(if return_after { ReturnDocument::After } else { ReturnDocument::Before })
                .upsert(upsert)
                .build();
            let result = coll.find_one_and_update(filter, update, opts)
                .await.map_err(mongo_err)?;
            Ok(result.map(|d| bson_to_value(&d)).unwrap_or(Value::Null))
        }

        // ── findOneAndDelete ───────────────────────────────────────────────
        "findOneAndDelete" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Null))?;
            let opts = FindOneAndDeleteOptions::builder().build();
            let result = coll.find_one_and_delete(filter, opts)
                .await.map_err(mongo_err)?;
            Ok(result.map(|d| bson_to_value(&d)).unwrap_or(Value::Null))
        }

        // ── findOneAndReplace ──────────────────────────────────────────────
        "findOneAndReplace" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter      = value_to_doc(args.get("filter").unwrap_or(&Value::Null))?;
            let replacement = value_to_doc(args.get("replacement").unwrap_or(&Value::Null))?;
            let return_after = args.get("returnDocument").and_then(|v| v.as_str()) == Some("after");
            let upsert = args.get("upsert").and_then(|v| v.as_bool()).unwrap_or(false);
            let opts = FindOneAndReplaceOptions::builder()
                .return_document(if return_after { ReturnDocument::After } else { ReturnDocument::Before })
                .upsert(upsert)
                .build();
            let result = coll.find_one_and_replace(filter, replacement, opts)
                .await.map_err(mongo_err)?;
            Ok(result.map(|d| bson_to_value(&d)).unwrap_or(Value::Null))
        }

        // ── distinct ───────────────────────────────────────────────────────
        "distinct" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let field = args.get("field").and_then(|v| v.as_str()).ok_or("Missing field")?;
            let filter = args.get("filter").map(value_to_doc).transpose()?;
            let result = coll.distinct(field, filter, None)
                .await.map_err(mongo_err)?;
            Ok(bson_to_value(&result))
        }

        // ── createIndex ────────────────────────────────────────────────────
        "createIndex" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let keys = value_to_doc(args.get("keys").unwrap_or(&Value::Null))?;
            let index_opts_val = args.get("options");
            let name: Option<String> = index_opts_val.and_then(|o| o.get("name")).and_then(|v| v.as_str()).map(|s| s.to_string());
            let unique: Option<bool> = index_opts_val.and_then(|o| o.get("unique")).and_then(|v| v.as_bool());
            let opts = IndexOptions::builder().name(name).unique(unique).build();
            let model = IndexModel::builder().keys(keys).options(opts).build();
            let result = coll.create_index(model, None).await.map_err(mongo_err)?;
            Ok(Value::String(result.index_name))
        }

        // ── dropIndex ──────────────────────────────────────────────────────
        "dropIndex" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let name = args.get("name").and_then(|v| v.as_str()).ok_or("Missing index name")?;
            coll.drop_index(name, None).await.map_err(mongo_err)?;
            Ok(Value::Null)
        }

        // ── listIndexes ────────────────────────────────────────────────────
        "listIndexes" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            use futures_util::TryStreamExt;
            let indexes: Vec<_> = coll.list_indexes(None)
                .await.map_err(mongo_err)?
                .try_collect()
                .await.map_err(mongo_err)?;
            Ok(bson_to_value(&indexes))
        }

        // ── runCommand ─────────────────────────────────────────────────────
        "runCommand" => {
            let db_name = op.database.as_deref().ok_or("Missing database")?;
            let cmd = value_to_doc(args.get("command").unwrap_or(&Value::Null))?;
            let result = state.client()?.database(db_name)
                .run_command(cmd, None)
                .await
                .map_err(mongo_err)?;
            Ok(bson_to_value(&result))
        }

        // ── listCollections ────────────────────────────────────────────────
        "listCollections" => {
            let db_name = op.database.as_deref().ok_or("Missing database")?;
            use futures_util::TryStreamExt;
            let specs: Vec<_> = state.client()?.database(db_name)
                .list_collections(None, None)
                .await
                .map_err(mongo_err)?
                .try_collect()
                .await
                .map_err(mongo_err)?;
            Ok(bson_to_value(&specs))
        }

        // ── dropCollection ─────────────────────────────────────────────────
        "dropCollection" => {
            let db_name = op.database.as_deref().ok_or("Missing database")?;
            let coll_name = op.collection.as_deref()
                .or_else(|| args.get("collection").and_then(|v| v.as_str()))
                .ok_or("Missing collection")?;
            state.client()?.database(db_name)
                .collection::<Document>(coll_name)
                .drop(None)
                .await
                .map_err(mongo_err)?;
            Ok(Value::Null)
        }

        // ── createCollection ───────────────────────────────────────────────
        "createCollection" => {
            let db_name = op.database.as_deref().ok_or("Missing database")?;
            let coll_name = args.get("collection").and_then(|v| v.as_str())
                .ok_or("Missing collection argument")?;
            state.client()?.database(db_name)
                .create_collection(coll_name, None)
                .await
                .map_err(mongo_err)?;
            Ok(Value::Null)
        }

        // ── listDatabases ──────────────────────────────────────────────────
        "listDatabases" => {
            let names = state.client()?
                .list_database_names(None, None)
                .await
                .map_err(mongo_err)?;
            Ok(bson_to_value(&names))
        }

        // ── bulkWrite ──────────────────────────────────────────────────────
        "bulkWrite" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let ordered = args.get("ordered").and_then(|v| v.as_bool()).unwrap_or(true);
            let requests = args.get("requests").and_then(|v| v.as_array())
                .ok_or("Missing requests array")?
                .clone();
            let mut inserted_count: i64 = 0;
            let mut matched_count: i64 = 0;
            let mut modified_count: i64 = 0;
            let mut deleted_count: i64 = 0;
            let mut first_error: Option<DispatchError> = None;
            for req in &requests {
                let op_result: Result<(), DispatchError> =
                    if let Some(ins) = req.get("insertOne") {
                        let doc = value_to_doc(ins.get("document").unwrap_or(&Value::Null))?;
                        coll.insert_one(doc, None).await
                            .map(|_| { inserted_count += 1; })
                            .map_err(mongo_err)
                    } else if let Some(upd) = req.get("updateOne") {
                        let filter = value_to_doc(upd.get("filter").unwrap_or(&Value::Null))?;
                        let update = value_to_doc(upd.get("update").unwrap_or(&Value::Null))?;
                        coll.update_one(filter, update, None).await
                            .map(|r| { matched_count += r.matched_count as i64; modified_count += r.modified_count as i64; })
                            .map_err(mongo_err)
                    } else if let Some(upd) = req.get("updateMany") {
                        let filter = value_to_doc(upd.get("filter").unwrap_or(&Value::Null))?;
                        let update = value_to_doc(upd.get("update").unwrap_or(&Value::Null))?;
                        coll.update_many(filter, update, None).await
                            .map(|r| { matched_count += r.matched_count as i64; modified_count += r.modified_count as i64; })
                            .map_err(mongo_err)
                    } else if let Some(del) = req.get("deleteOne") {
                        let filter = value_to_doc(del.get("filter").unwrap_or(&Value::Null))?;
                        coll.delete_one(filter, None).await
                            .map(|r| { deleted_count += r.deleted_count as i64; })
                            .map_err(mongo_err)
                    } else if let Some(del) = req.get("deleteMany") {
                        let filter = value_to_doc(del.get("filter").unwrap_or(&Value::Null))?;
                        coll.delete_many(filter, None).await
                            .map(|r| { deleted_count += r.deleted_count as i64; })
                            .map_err(mongo_err)
                    } else if let Some(rep) = req.get("replaceOne") {
                        let filter = value_to_doc(rep.get("filter").unwrap_or(&Value::Null))?;
                        let replacement = value_to_doc(rep.get("replacement").unwrap_or(&Value::Null))?;
                        coll.replace_one(filter, replacement, None).await
                            .map(|r| { matched_count += r.matched_count as i64; modified_count += r.modified_count as i64; })
                            .map_err(mongo_err)
                    } else {
                        Err("Unknown write model in bulkWrite".into())
                    };
                match op_result {
                    Err(e) if ordered => return Err(e),
                    Err(e) if first_error.is_none() => { first_error = Some(e); }
                    _ => {}
                }
            }
            let result = serde_json::json!({
                "acknowledged": true,
                "insertedCount": inserted_count,
                "matchedCount":  matched_count,
                "modifiedCount": modified_count,
                "deletedCount":  deleted_count,
                "upsertedCount": 0,
            });
            if let Some(err) = first_error { return Err(err); }
            Ok(result)
        }

        other => Err(format!("Unsupported operation: \"{other}\"").into()),
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    let state = Arc::new(Mutex::new(ShimState::new()));

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if l.trim().is_empty() => continue,
            Ok(l) => l,
            Err(e) => {
                eprintln!("[rust-shim] stdin read error: {e}");
                break;
            }
        };

        let msg: InboundMessage = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[rust-shim] parse error: {e} — line: {line}");
                continue;
            }
        };

        let id = msg.id;
        let response = handle_message(Arc::clone(&state), msg).await;

        let json = serde_json::to_string(&response).unwrap_or_else(|e| {
            format!(r#"{{"id":{id},"error":{{"message":"serialisation error: {e}"}}}}"#)
        });
        if let Err(e) = writeln!(out, "{json}") {
            eprintln!("[rust-shim] stdout write error: {e}");
            break;
        }
        let _ = out.flush();
    }
}

async fn handle_message(state: Arc<Mutex<ShimState>>, msg: InboundMessage) -> OutboundMessage {
    let id = msg.id;

    match msg.msg_type.as_str() {
        "connect" => {
            let uri = msg.payload.get("uri")
                .and_then(|v| v.as_str())
                .unwrap_or("mongodb://localhost:27017");

            match ClientOptions::parse(uri).await {
                Err(e) => return err_response(id, e.to_string(), None, None),
                Ok(opts) => match Client::with_options(opts) {
                    Err(e) => return err_response(id, e.to_string(), None, None),
                    Ok(client) => {
                        let mut s = state.lock().await;
                        s.client = Some(client);
                        OutboundMessage { id, result: Some(Value::Null), error: None }
                    }
                },
            }
        }

        "disconnect" => {
            let mut s = state.lock().await;
            // End any open sessions first (best-effort)
            for (_, mut session) in s.sessions.drain() {
                let _ = session.abort_transaction().await;
            }
            s.client = None;
            OutboundMessage { id, result: Some(Value::Null), error: None }
        }

        "operation" => {
            let op: Operation = match serde_json::from_value(msg.payload) {
                Ok(o) => o,
                Err(e) => return err_response(id, format!("Bad operation payload: {e}"), None, None),
            };
            let op_name = op.name.clone();
            let mut s = state.lock().await;
            match dispatch(&mut s, op).await {
                Ok(result) => OutboundMessage { id, result: Some(result), error: None },
                Err(e) => {
                    eprintln!("[rust-shim] error (id={id} op={op_name}): {}", e.message);
                    OutboundMessage {
                        id,
                        result: None,
                        error: Some(ShimError { message: e.message, code: e.code, labels: None }),
                    }
                }
            }
        }

        other => err_response(id, format!("Unknown message type: \"{other}\""), None, None),
    }
}

fn err_response(id: u64, message: String, code: Option<i32>, labels: Option<Vec<String>>) -> OutboundMessage {
    eprintln!("[rust-shim] error (id={id}): {message}");
    OutboundMessage {
        id,
        result: None,
        error: Some(ShimError { message, code, labels }),
    }
}
