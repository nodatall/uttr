use crate::access::backend_base_url;
use crate::settings::{AccessState, EntitlementState, PostProcessProvider, TrialState};
use log::{debug, warn};
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const CODEX_SUMMARY_TIMEOUT: Duration = Duration::from_secs(25);
const BACKEND_SUMMARY_TIMEOUT: Duration = Duration::from_secs(45);
const CODEX_SUMMARY_MODEL_FALLBACK: &str = "gpt-5.4-mini";

static BACKEND_SUMMARY_CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(BACKEND_SUMMARY_TIMEOUT)
        .build()
        .expect("Failed to build backend summary HTTP client")
});

#[derive(Debug, Deserialize)]
struct BackendSummaryResponse {
    summary: String,
    trial_state: TrialState,
    access_state: AccessState,
    entitlement_state: EntitlementState,
}

#[derive(Debug, Clone)]
pub struct BackendSummaryResult {
    pub summary: String,
    pub trial_state: TrialState,
    pub access_state: AccessState,
    pub entitlement_state: EntitlementState,
}

#[derive(Debug, Serialize)]
struct BackendSummaryRequest<'a> {
    transcript_text: &'a str,
    previous_summary: Option<&'a str>,
    chunk_count: u64,
}

fn codex_binary_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(binary) = std::env::var("UTTR_CODEX_BINARY") {
        let trimmed = binary.trim();
        if !trimmed.is_empty() {
            candidates.push(trimmed.to_string());
        }
    }

    candidates.extend([
        "codex".to_string(),
        "/Applications/Codex.app/Contents/Resources/codex".to_string(),
        "/usr/local/bin/codex".to_string(),
        "/opt/homebrew/bin/codex".to_string(),
    ]);
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!(
            "{}/Applications/Codex.app/Contents/Resources/codex",
            home.trim_end_matches('/')
        ));
    }

    candidates
}

fn codex_summary_model() -> String {
    std::env::var("UTTR_CODEX_SUMMARY_MODEL")
        .ok()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| CODEX_SUMMARY_MODEL_FALLBACK.to_string())
}

fn write_json_line(stdin: &mut std::process::ChildStdin, value: Value) -> Result<(), String> {
    let line = serde_json::to_string(&value)
        .map_err(|error| format!("Failed to encode Codex app-server request: {}", error))?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .map_err(|error| format!("Failed to write to Codex app-server: {}", error))
}

fn codex_request(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

fn codex_notification(method: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": method,
    })
}

fn spawn_codex_summary_reader(
    stdout: std::process::ChildStdout,
) -> mpsc::Receiver<Result<Value, String>> {
    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) if !line.trim().is_empty() => {
                    let parsed = serde_json::from_str::<Value>(&line).map_err(|error| {
                        format!("Failed to parse Codex app-server response: {}", error)
                    });
                    if tx.send(parsed).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = tx.send(Err(format!(
                        "Failed to read from Codex app-server: {}",
                        error
                    )));
                    break;
                }
            }
        }
    });

    rx
}

fn choose_codex_model(model_list_response: &Value) -> String {
    let fallback = codex_summary_model();
    let Some(models) = model_list_response
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
    else {
        return fallback;
    };

    models
        .iter()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .find(|id| id.contains("mini"))
        .or_else(|| {
            models.iter().find_map(|model| {
                let is_default = model
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                is_default
                    .then(|| model.get("id").and_then(Value::as_str))
                    .flatten()
            })
        })
        .or_else(|| {
            models
                .first()
                .and_then(|model| model.get("id").and_then(Value::as_str))
        })
        .unwrap_or(&fallback)
        .to_string()
}

fn spawn_codex_app_server() -> Result<Child, String> {
    let mut errors = Vec::new();

    for binary in codex_binary_candidates() {
        match Command::new(&binary)
            .args([
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "mcp_servers={}",
                "-c",
                "tools.web_search=false",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(error) => errors.push(format!("{}: {}", binary, error)),
        }
    }

    Err(format!(
        "Codex app-server is not available. Tried: {}",
        errors.join("; ")
    ))
}

fn stop_codex_app_server(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn run_codex_app_text_task(
    prompt: String,
    system_prompt: String,
    developer_instructions: &'static str,
    service_name: &'static str,
    empty_error: &'static str,
    failure_label: &'static str,
) -> Result<String, String> {
    let started = Instant::now();
    let mut child = spawn_codex_app_server()?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex app-server stdin was not available.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex app-server stdout was not available.".to_string())?;
    let rx = spawn_codex_summary_reader(stdout);

    write_json_line(
        &mut stdin,
        codex_request(
            1,
            "initialize",
            json!({
                "clientInfo": {
                    "name": "uttr",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "capabilities": {
                    "experimentalApi": true,
                    "optOutNotificationMethods": [
                        "mcpServer/startupStatus/updated",
                        "skills/changed"
                    ],
                },
            }),
        ),
    )?;
    write_json_line(&mut stdin, codex_notification("initialized"))?;
    write_json_line(
        &mut stdin,
        codex_request(2, "account/read", json!({ "refreshToken": false })),
    )?;
    write_json_line(
        &mut stdin,
        codex_request(
            3,
            "model/list",
            json!({ "limit": 50, "includeHidden": false }),
        ),
    )?;

    let mut thread_id: Option<String> = None;
    let mut selected_model: Option<String> = None;
    let mut agent_text = String::new();

    loop {
        let elapsed = started.elapsed();
        if elapsed >= CODEX_SUMMARY_TIMEOUT {
            stop_codex_app_server(&mut child);
            return Err("Codex summary timed out.".to_string());
        }

        let message = match rx.recv_timeout(CODEX_SUMMARY_TIMEOUT - elapsed) {
            Ok(Ok(message)) => message,
            Ok(Err(error)) => {
                stop_codex_app_server(&mut child);
                return Err(error);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                stop_codex_app_server(&mut child);
                return Err("Codex summary timed out.".to_string());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                stop_codex_app_server(&mut child);
                return Err("Codex app-server exited before returning a summary.".to_string());
            }
        };

        if let Some(error) = message.get("error") {
            stop_codex_app_server(&mut child);
            return Err(format!("Codex app-server request failed: {}", error));
        }

        match message.get("id").and_then(Value::as_u64) {
            Some(2) => {
                let has_account = !message
                    .get("result")
                    .and_then(|result| result.get("account"))
                    .unwrap_or(&Value::Null)
                    .is_null();
                if !has_account {
                    stop_codex_app_server(&mut child);
                    return Err("Codex is installed but not authenticated.".to_string());
                }
            }
            Some(3) => {
                let model = choose_codex_model(&message);
                selected_model = Some(model.clone());
                write_json_line(
                    &mut stdin,
                    codex_request(
                        4,
                        "thread/start",
                        json!({
                            "cwd": std::env::temp_dir().to_string_lossy(),
                            "approvalPolicy": "never",
                            "sandbox": "read-only",
                            "ephemeral": true,
                            "baseInstructions": system_prompt,
                            "developerInstructions": developer_instructions,
                            "serviceName": service_name,
                            "model": model,
                            "config": {
                                "mcp_servers": {},
                                "tools": { "web_search": false }
                            }
                        }),
                    ),
                )?;
            }
            Some(4) => {
                let Some(id) = message
                    .get("result")
                    .and_then(|result| result.get("thread"))
                    .and_then(|thread| thread.get("id"))
                    .and_then(Value::as_str)
                else {
                    stop_codex_app_server(&mut child);
                    return Err("Codex app-server did not return a thread id.".to_string());
                };
                thread_id = Some(id.to_string());

                write_json_line(
                    &mut stdin,
                    codex_request(
                        5,
                        "turn/start",
                        json!({
                            "threadId": id,
                            "input": [{
                                "type": "text",
                                "text": prompt,
                                "text_elements": []
                            }],
                            "approvalPolicy": "never",
                            "model": selected_model.as_deref(),
                            "effort": "low"
                        }),
                    ),
                )?;
            }
            Some(_) | None => {}
        }

        if message
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method == "item/agentMessage/delta")
        {
            if let Some(delta) = message
                .get("params")
                .and_then(|params| params.get("delta"))
                .and_then(Value::as_str)
            {
                agent_text.push_str(delta);
            }
        }

        if message
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method == "item/completed")
        {
            if let Some(text) = message
                .get("params")
                .and_then(|params| params.get("item"))
                .and_then(|item| {
                    (item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                        .then_some(item)
                })
                .and_then(|item| item.get("text"))
                .and_then(Value::as_str)
            {
                agent_text = text.to_string();
            }
        }

        if message
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method == "turn/completed")
        {
            let turn = message
                .get("params")
                .and_then(|params| params.get("turn"))
                .ok_or_else(|| "Codex app-server turn completed without a turn.".to_string())?;
            let status = turn.get("status").and_then(Value::as_str).unwrap_or("");
            stop_codex_app_server(&mut child);
            if status == "completed" {
                let output = agent_text.trim();
                if output.is_empty() {
                    return Err(empty_error.to_string());
                }
                debug!(
                    "Codex app-server {} completed in {}ms for thread {:?}",
                    service_name,
                    started.elapsed().as_millis(),
                    thread_id
                );
                return Ok(output.to_string());
            }

            return Err(format!(
                "{} failed: {}",
                failure_label,
                turn.get("error")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "unknown error".to_string())
            ));
        }
    }
}

fn run_codex_app_summary(prompt: String, system_prompt: String) -> Result<String, String> {
    run_codex_app_text_task(
        prompt,
        system_prompt,
        "Do not use tools. Return only the requested live session summary.",
        "uttr-summary",
        "Codex returned an empty summary.",
        "Codex summary",
    )
}

fn run_codex_app_transform(prompt: String, system_prompt: String) -> Result<String, String> {
    run_codex_app_text_task(
        prompt,
        system_prompt,
        "Do not use tools. Return only the replacement text. Do not explain.",
        "uttr-edit-mode",
        "Codex returned an empty edit.",
        "Codex edit transform",
    )
}

pub async fn summarize_with_codex_app(
    prompt: String,
    system_prompt: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_codex_app_summary(prompt, system_prompt))
        .await
        .map_err(|error| format!("Codex summary task failed: {}", error))?
}

pub async fn transform_with_codex_app(
    prompt: String,
    system_prompt: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_codex_app_transform(prompt, system_prompt))
        .await
        .map_err(|error| format!("Codex edit transform task failed: {}", error))?
}

pub async fn summarize_with_provider(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    prompt: String,
    system_prompt: &str,
) -> Result<String, String> {
    crate::llm_client::send_chat_completion(provider, api_key, model, prompt, Some(system_prompt))
        .await?
        .map(|summary| summary.trim().to_string())
        .filter(|summary| !summary.is_empty())
        .ok_or_else(|| "OpenAI returned an empty summary.".to_string())
}

pub async fn summarize_with_backend(
    install_token: &str,
    transcript_text: &str,
    previous_summary: Option<&str>,
    chunk_count: u64,
) -> Result<BackendSummaryResult, String> {
    if install_token.trim().is_empty() {
        return Err("Install token is required for backend summaries.".to_string());
    }

    let response = BACKEND_SUMMARY_CLIENT
        .post(format!("{}/api/session/summary", backend_base_url()))
        .header("install-token", install_token.trim())
        .json(&BackendSummaryRequest {
            transcript_text,
            previous_summary,
            chunk_count,
        })
        .send()
        .await
        .map_err(|error| format!("Backend summary request failed: {}", error))?;

    let status = response.status();
    if !status.is_success() {
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read backend summary error response body".to_string());
        return Err(format!("Backend summary failed ({}): {}", status, body));
    }

    let parsed = response
        .json::<BackendSummaryResponse>()
        .await
        .map_err(|error| format!("Failed to parse backend summary response: {}", error))?;

    Ok(BackendSummaryResult {
        summary: parsed.summary,
        trial_state: parsed.trial_state,
        access_state: parsed.access_state,
        entitlement_state: parsed.entitlement_state,
    })
}

pub fn summarize_codex_unavailable(error: &str) {
    warn!("Codex summary route unavailable: {}", error);
}
