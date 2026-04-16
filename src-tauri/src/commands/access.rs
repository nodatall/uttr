use crate::access::{
    bootstrap_install_state, get_install_access_snapshot as build_install_access_snapshot,
    refresh_entitlement_state, request_claim_token, ClaimTokenResult, InstallAccessSnapshot,
};
#[cfg(debug_assertions)]
use crate::access::{set_dev_access_override, DevAccessOverride};
use log::warn;
use tauri::{AppHandle, Emitter};

#[tauri::command]
#[specta::specta]
pub async fn bootstrap_install_access(app: AppHandle) -> Result<InstallAccessSnapshot, String> {
    bootstrap_install_state(&app).await?;

    if let Err(error) = refresh_entitlement_state(&app).await {
        warn!("Bootstrap entitlement refresh failed: {}", error);
    }

    Ok(build_install_access_snapshot(&app))
}

#[tauri::command]
#[specta::specta]
pub async fn refresh_install_entitlement(app: AppHandle) -> Result<InstallAccessSnapshot, String> {
    refresh_entitlement_state(&app).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_trial_claim(app: AppHandle) -> Result<ClaimTokenResult, String> {
    request_claim_token(&app).await
}

#[tauri::command]
#[specta::specta]
pub fn get_install_access_snapshot(app: AppHandle) -> Result<InstallAccessSnapshot, String> {
    Ok(build_install_access_snapshot(&app))
}

#[tauri::command]
#[specta::specta]
pub fn set_dev_install_access_override(
    app: AppHandle,
    mode: String,
) -> Result<InstallAccessSnapshot, String> {
    #[cfg(debug_assertions)]
    {
        let override_mode = match mode.as_str() {
            "free" => DevAccessOverride::Free,
            "trial" => DevAccessOverride::Trial,
            "pro" => DevAccessOverride::Pro,
            "none" => DevAccessOverride::None,
            other => return Err(format!("Unknown dev access override: {}", other)),
        };

        set_dev_access_override(override_mode);
        let snapshot = build_install_access_snapshot(&app);
        let _ = app.emit("install-access-changed", snapshot.clone());
        return Ok(snapshot);
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        let _ = mode;
        Err("Developer access simulation is only available in debug builds.".to_string())
    }
}
