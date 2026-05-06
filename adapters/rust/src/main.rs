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
    Client, ClientSession, Collection,
    options::{ClientOptions, SessionOptions},
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

    fn client(&self) -> Result<&Client, String> {
        self.client.as_ref().ok_or_else(|| "Not connected".to_string())
    }

    fn require_session(&mut self, key: &str) -> Result<&mut ClientSession, String> {
        self.sessions
            .get_mut(key)
            .ok_or_else(|| format!("No session with key \"{}\"", key))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Convert a `serde_json::Value` to a BSON `Document`.
fn value_to_doc(v: &Value) -> Result<Document, String> {
    bson::to_document(&v).map_err(|e| format!("BSON conversion failed: {e}"))
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

async fn dispatch(state: &mut ShimState, op: Operation) -> Result<Value, String> {
    let args = &op.arguments;
    let session_key = session_key_from_args(args);

    match op.name.as_str() {
        // ── Connection ─────────────────────────────────────────────────────
        // (handled in the main loop, not here)

        // ── Session lifecycle ──────────────────────────────────────────────
        "startSession" => {
            let client = state.client()?.clone();
            let opts = SessionOptions::builder().build();
            let session = client
                .start_session()
                .with_options(opts)
                .await
                .map_err(|e| e.to_string())?;
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
            session.start_transaction().await.map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }

        "commitTransaction" => {
            let session = state.require_session(&op.object)?;
            session.commit_transaction().await.map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }

        "abortTransaction" => {
            let session = state.require_session(&op.object)?;
            session.abort_transaction().await.map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }

        // ── insertOne ──────────────────────────────────────────────────────
        "insertOne" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let doc = value_to_doc(args.get("document").unwrap_or(&Value::Null))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.insert_one(doc).session(session).await
            } else {
                coll.insert_one(doc).await
            }.map_err(|e| e.to_string())?;
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
                coll.insert_many(docs).session(session).await
            } else {
                coll.insert_many(docs).await
            }.map_err(|e| e.to_string())?;
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
                coll.find_one(filter).session(session).await
            } else {
                coll.find_one(filter).await
            }.map_err(|e| e.to_string())?;
            Ok(result.map(|d| bson_to_value(&d)).unwrap_or(Value::Null))
        }

        // ── find ───────────────────────────────────────────────────────────
        "find" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            use futures_util::TryStreamExt;
            let docs: Vec<Document> = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.find(filter)
                    .session(&mut *session)
                    .await
                    .map_err(|e| e.to_string())?
                    .stream(session)
                    .try_collect()
                    .await
                    .map_err(|e| e.to_string())?
            } else {
                coll.find(filter)
                    .await
                    .map_err(|e| e.to_string())?
                    .try_collect()
                    .await
                    .map_err(|e| e.to_string())?
            };
            Ok(bson_to_value(&docs))
        }

        // ── updateOne ──────────────────────────────────────────────────────
        "updateOne" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Null))?;
            let update = value_to_doc(args.get("update").unwrap_or(&Value::Null))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.update_one(filter, update).session(session).await
            } else {
                coll.update_one(filter, update).await
            }.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "acknowledged": true,
                "matchedCount":  result.matched_count,
                "modifiedCount": result.modified_count,
            }))
        }

        // ── updateMany ─────────────────────────────────────────────────────
        "updateMany" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Null))?;
            let update = value_to_doc(args.get("update").unwrap_or(&Value::Null))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.update_many(filter, update).session(session).await
            } else {
                coll.update_many(filter, update).await
            }.map_err(|e| e.to_string())?;
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
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.replace_one(filter, replacement).session(session).await
            } else {
                coll.replace_one(filter, replacement).await
            }.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "acknowledged": true,
                "matchedCount":  result.matched_count,
                "modifiedCount": result.modified_count,
            }))
        }

        // ── deleteOne ──────────────────────────────────────────────────────
        "deleteOne" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.delete_one(filter).session(session).await
            } else {
                coll.delete_one(filter).await
            }.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "acknowledged": true, "deletedCount": result.deleted_count }))
        }

        // ── deleteMany ─────────────────────────────────────────────────────
        "deleteMany" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            let result = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.delete_many(filter).session(session).await
            } else {
                coll.delete_many(filter).await
            }.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "acknowledged": true, "deletedCount": result.deleted_count }))
        }

        // ── countDocuments ─────────────────────────────────────────────────
        "countDocuments" => {
            let coll = collection(state.client()?, &op.database, &op.collection)?;
            let filter = value_to_doc(args.get("filter").unwrap_or(&Value::Object(Default::default())))?;
            let n = if let Some(ref key) = session_key {
                let session = state.require_session(key)?;
                coll.count_documents(filter).session(session).await
            } else {
                coll.count_documents(filter).await
            }.map_err(|e| e.to_string())?;
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
                        coll.aggregate(pipeline).session(&mut *session).await
                            .map_err(|e| e.to_string())?
                            .stream(session)
                            .try_collect()
                            .await
                            .map_err(|e| e.to_string())?
                    } else {
                        coll.aggregate(pipeline).await
                            .map_err(|e| e.to_string())?
                            .try_collect()
                            .await
                            .map_err(|e| e.to_string())?
                    }
                }
                None => {
                    let db = client.database(db_name);
                    db.aggregate(pipeline).await
                        .map_err(|e| e.to_string())?
                        .try_collect()
                        .await
                        .map_err(|e| e.to_string())?
                }
            };
            Ok(bson_to_value(&docs))
        }

        // ── runCommand ─────────────────────────────────────────────────────
        "runCommand" => {
            let db_name = op.database.as_deref().ok_or("Missing database")?;
            let cmd = value_to_doc(args.get("command").unwrap_or(&Value::Null))?;
            let result = state.client()?.database(db_name)
                .run_command(cmd)
                .await
                .map_err(|e| e.to_string())?;
            Ok(bson_to_value(&result))
        }

        // ── listCollections ────────────────────────────────────────────────
        "listCollections" => {
            let db_name = op.database.as_deref().ok_or("Missing database")?;
            use futures_util::TryStreamExt;
            let specs: Vec<_> = state.client()?.database(db_name)
                .list_collections()
                .await
                .map_err(|e| e.to_string())?
                .try_collect()
                .await
                .map_err(|e| e.to_string())?;
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
                .drop()
                .await
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }

        // ── createCollection ───────────────────────────────────────────────
        "createCollection" => {
            let db_name = op.database.as_deref().ok_or("Missing database")?;
            let coll_name = args.get("collection").and_then(|v| v.as_str())
                .ok_or("Missing collection argument")?;
            state.client()?.database(db_name)
                .create_collection(coll_name)
                .await
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }

        // ── listDatabases ──────────────────────────────────────────────────
        "listDatabases" => {
            let names = state.client()?
                .list_database_names()
                .await
                .map_err(|e| e.to_string())?;
            Ok(bson_to_value(&names))
        }

        other => Err(format!("Unsupported operation: \"{other}\"")),
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
            let mut s = state.lock().await;
            match dispatch(&mut s, op).await {
                Ok(result) => OutboundMessage { id, result: Some(result), error: None },
                Err(msg)   => err_response(id, msg, None, None),
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
