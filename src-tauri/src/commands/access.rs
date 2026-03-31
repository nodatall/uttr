use crate::access::{
    bootstrap_install_state, get_install_access_snapshot as build_install_access_snapshot,
    refresh_entitlement_state, request_claim_token, ClaimTokenResult, InstallAccessSnapshot,
};
use log::warn;
use tauri::AppHandle;

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
