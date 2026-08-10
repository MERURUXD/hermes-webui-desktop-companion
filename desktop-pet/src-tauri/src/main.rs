#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::process;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{atomic::AtomicBool, atomic::Ordering, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Listener, Manager, Url, WebviewWindow};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, ERROR_ALREADY_EXISTS};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::CreateMutexW;

const CLOSE_PET_MENU_ID: &str = "close_pet";
const MANAGE_PETS_MENU_ID: &str = "manage_pets";
const RESTART_PET_MENU_ID: &str = "restart_pet";
const PET_NATIVE_RESTART_REQUESTED_EVENT: &str = "pet-native-restart-requested";
const PET_CONTEXT_MENU_EVENT: &str = "pet-context-menu";
const PET_SKIN_CHANGE_EVENT: &str = "pet-skin-change";
const PET_RESTART_REQUESTED_EVENT: &str = "pet-restart-requested";
const PET_RAISE_REQUESTED_EVENT: &str = "pet-raise-requested";
const PET_VISIBILITY_CHANGE_EVENT: &str = "pet-visibility-change";
const PET_PERMISSION_TOGGLE_EVENT: &str = "pet-permission-toggle";
const SKIN_MENU_PREFIX: &str = "skin:";
const PERMISSION_MENU_PREFIX: &str = "permission:";
const BUBBLE_STYLE_PREFIX: &str = "bubblestyle:";
const PET_BUBBLE_STYLE_CHANGE_EVENT: &str = "pet-bubble-style-change";

const LOOPBACK_ADDR: &str = "127.0.0.1:17787";

#[cfg(target_os = "windows")]
struct SingleInstanceMutex(HANDLE);

#[cfg(target_os = "windows")]
impl Drop for SingleInstanceMutex {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[cfg(target_os = "windows")]
fn acquire_single_instance() -> Option<SingleInstanceMutex> {
    let name: Vec<u16> = "Local\\HermesWebUIDesktopCompanion"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mutex = unsafe { CreateMutexW(None, false, windows::core::PCWSTR(name.as_ptr())) }
        .expect("failed to create desktop companion mutex");
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        let _ = unsafe { CloseHandle(mutex) };
        return None;
    }
    Some(SingleInstanceMutex(mutex))
}

struct Sidecar {
    child: Mutex<Option<Child>>,
    /// Held open for the process lifetime; closing it kills the sidecar.
    #[cfg(target_os = "windows")]
    #[allow(dead_code)]
    job: Mutex<Option<JobHandle>>,
}

/// Raw handle wrapper so Sidecar state stays Send + Sync for tauri::manage.
#[cfg(target_os = "windows")]
struct JobHandle(HANDLE);

#[cfg(target_os = "windows")]
unsafe impl Send for JobHandle {}

#[cfg(target_os = "windows")]
unsafe impl Sync for JobHandle {}

#[cfg(target_os = "windows")]
impl Drop for JobHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

#[cfg(target_os = "windows")]
fn assign_kill_on_close_job(child: &Child) -> Option<JobHandle> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let Ok(job) = CreateJobObjectW(None, None) else {
            return None;
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size,
        )
        .is_err()
        {
            let _ = CloseHandle(job);
            return None;
        }
        if AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())).is_err() {
            let _ = CloseHandle(job);
            return None;
        }
        Some(JobHandle(job))
    }
}

impl Sidecar {
    #[cfg(target_os = "windows")]
    fn hermes_cli_path() -> Option<PathBuf> {
        for key in ["HERMES_DESKTOP_COMPANION_HERMES_CLI", "HERMES_CLI"] {
            if let Some(path) = std::env::var_os(key).map(PathBuf::from) {
                if path.is_file() && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
                    return Some(path);
                }
            }
        }

        if let Ok(output) = Command::new("where.exe").arg("hermes.exe").output() {
            if output.status.success() {
                if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = PathBuf::from(path.trim());
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }

        let mut candidates = Vec::new();
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            let home = PathBuf::from(user_profile);
            candidates.push(home.join(".local\\bin\\hermes.exe"));
            candidates.push(home.join("scoop\\shims\\hermes.exe"));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local_app_data).join("Microsoft\\WinGet\\Links\\hermes.exe"));
        }
        if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
            return Some(path);
        }

        // Hermes Desktop keeps its managed runtime under
        // %USERPROFILE%\.hermes-web-ui\desktop-runtime\hermes\<version>\win-x64
        // (verified 2026-08-10: active-version.json "runtimeDirectory" ->
        // ...\hermes\0.20.0\win-x64, CLI = python.exe -m hermes_cli.main).
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            let home = PathBuf::from(user_profile);
            let runtime_root = home.join(".hermes-web-ui").join("desktop-runtime");
            let mut version_dirs = Vec::new();
            let active = runtime_root.join("active-version.json");
            if let Ok(contents) = fs::read_to_string(active) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) {
                    if let Some(dir) = value.get("runtimeDirectory").and_then(|v| v.as_str()) {
                        let path = PathBuf::from(dir);
                        let path = if path.is_absolute() { path } else { runtime_root.join(path) };
                        // runtimeDirectory 是 arch 目录形态（...\hermes\<ver>\win-x64）：直接探测
                        for python in [
                            path.join("python").join("venv").join("Scripts").join("python.exe"),
                            path.join("python").join("python.exe"),
                        ] {
                            if python.is_file() {
                                return Some(python);
                            }
                        }
                        // 也可能是 version_dir 形态（无 arch 段）：入队（优先于枚举结果）
                        version_dirs.push(path);
                    }
                }
            }
            if let Ok(entries) = fs::read_dir(runtime_root.join("hermes")) {
                version_dirs.extend(entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()));
            }
            for version_dir in version_dirs {
                for arch in ["win-x64", "win-x86"] {
                    let python = version_dir.join(arch).join("python").join("venv").join("Scripts").join("python.exe");
                    if python.is_file() {
                        return Some(python);
                    }
                    let python = version_dir.join(arch).join("python").join("python.exe");
                    if python.is_file() {
                        return Some(python);
                    }
                }
            }
        }
        None
    }

    fn start() -> Result<Self, Box<dyn std::error::Error>> {
        if Self::healthy() {
            return Ok(Self {
                child: Mutex::new(None),
                #[cfg(target_os = "windows")]
                job: Mutex::new(None),
            });
        }

        let root = std::env::var_os("HERMES_WORKSPACE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
            });
        let mut command = Command::new("node");
        command.args(["src/loopback-server.mjs"]).current_dir(root);
        let allowed_origins = std::env::var("HERMES_COMPANION_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "https://hermes.meruru.ccwu.cc".into());
        command.env("HERMES_COMPANION_ALLOWED_ORIGINS", allowed_origins);
        if let Ok(webui_base) = std::env::var("HERMES_DESKTOP_PET_WEBUI_BASE") {
            command.env("HERMES_DESKTOP_PET_WEBUI_BASE", webui_base);
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(path) = Self::hermes_cli_path() {
                let is_python = path
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("python.exe"));
                command.env("HERMES_DESKTOP_COMPANION_HERMES_CLI", path);
                if is_python {
                    command.env("HERMES_DESKTOP_COMPANION_HERMES_CLI_MODULE", "hermes_cli.main");
                }
            } else {
                eprintln!("[hwdc] hermes.exe not found; gallery installs may fail");
            }
            // HERMES_HOME 对齐：Hermes CLI 0.20 在 Windows 默认
            // %LOCALAPPDATA%\hermes（实测 pets install 装到 ...\hermes\pets），
            // 而 sidecar 检查默认 ~\.hermes\pets——两边不一致会装完查不到
            // （HTTP 200 + ok:false）。注入同一 home 使 CLI 与检查路径一致。
            if std::env::var_os("HERMES_HOME").is_none() {
                if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                    let hermes_home = PathBuf::from(local_app_data).join("hermes");
                    if hermes_home.is_dir() {
                        command.env("HERMES_HOME", hermes_home);
                    }
                }
            }
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        let child = command.spawn()?;
        #[cfg(target_os = "windows")]
        let job = assign_kill_on_close_job(&child);
        let sidecar = Self {
            child: Mutex::new(Some(child)),
            #[cfg(target_os = "windows")]
            job: Mutex::new(job),
        };
        if !sidecar.wait_until_healthy() {
            sidecar.stop();
            return Err("loopback sidecar did not become healthy within 5 seconds".into());
        }
        Ok(sidecar)
    }

    fn healthy() -> bool {
        let Ok(mut stream) = TcpStream::connect_timeout(
            &LOOPBACK_ADDR.parse().expect("valid loopback address"),
            Duration::from_millis(150),
        ) else {
            return false;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
        if stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .is_err()
        {
            return false;
        }
        let mut response = String::new();
        stream.read_to_string(&mut response).is_ok()
            && response.starts_with("HTTP/1.1 200")
    }

    fn wait_until_healthy(&self) -> bool {
        (0..50).any(|_| {
            if Self::healthy() {
                true
            } else {
                thread::sleep(Duration::from_millis(100));
                false
            }
        })
    }

    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

fn _persist_desktop_pet_preference(app: &tauri::AppHandle, enabled: bool) {
    let enabled_text = if enabled { "true" } else { "false" };
    let script = format!(
        "try{{const key='hermes-desktop-pet-enabled';const oldValue=localStorage.getItem(key);const token=window.__HERMES_CONFIG__&&window.__HERMES_CONFIG__.csrfToken;const headers={{'Content-Type':'application/json'}};if(token)headers['X-Hermes-CSRF-Token']=token;localStorage.setItem(key,'{enabled_text}');try{{window.dispatchEvent(new StorageEvent('storage',{{key,oldValue,newValue:'{enabled_text}',storageArea:localStorage,url:location.href}}));}}catch(_){{}}fetch('/api/pet/preference',{{method:'POST',credentials:'include',headers,body:JSON.stringify({{enabled:{enabled_text}}}),keepalive:true}}).catch(()=>{{}})}}catch(_){{}}"
    );
    for label in ["pet", "pet_bubbles"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.eval(&script);
        }
    }
}

fn _restart_native_process() {
    if let Ok(current_exe) = std::env::current_exe() {
        match Command::new(current_exe)
            .env("HERMES_COMPANION_RESTARTING", "1")
            .spawn()
        {
            Ok(_) => {
                // 给新进程初始化时间（PE 加载 + 进入 main）；新进程侧对互斥做重试等待，
                // 我们退出释放互斥后它即可继续，避免"新进程被单实例互斥拒绝 + 旧进程退出 = 全灭"
                thread::sleep(Duration::from_millis(500));
                process::exit(0);
            }
            Err(err) => {
                eprintln!("failed to spawn restart process: {err}");
            }
        }
    }
}

fn emit_pet_visibility(app: &tauri::AppHandle, visible: bool) {
    for label in ["pet", "pet_bubbles"] {
        let _ = app.emit_to(label, PET_VISIBILITY_CHANGE_EVENT, visible);
    }
    let retry_app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(600));
        for label in ["pet", "pet_bubbles"] {
            let _ = retry_app.emit_to(label, PET_VISIBILITY_CHANGE_EVENT, visible);
        }
    });
}

fn lower_pet_windows_for_menu(app: &tauri::AppHandle) {
    for label in ["pet", "pet_bubbles"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.set_always_on_top(false);
        }
    }
}

#[cfg(target_os = "macos")]
fn set_native_window_level(window: &WebviewWindow, level: objc2_app_kit::NSWindowLevel) {
    use objc2_app_kit::NSWindow;
    if let Ok(ptr) = window.ns_window() {
        if !ptr.is_null() {
            let ns_window: &NSWindow = unsafe { &*ptr.cast() };
            ns_window.setLevel(level);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn set_native_window_level(_window: &WebviewWindow, _level: i32) {}

#[cfg(target_os = "macos")]
fn set_native_ignore_cursor_events(window: &WebviewWindow, ignore: bool) {
    use objc2_app_kit::NSWindow;
    if let Ok(ptr) = window.ns_window() {
        if !ptr.is_null() {
            let ns_window: &NSWindow = unsafe { &*ptr.cast() };
            ns_window.setIgnoresMouseEvents(ignore);
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn set_native_ignore_cursor_events(_window: &WebviewWindow, _ignore: bool) {}

fn set_pet_window_level(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    set_native_window_level(window, objc2_app_kit::NSStatusWindowLevel);
    #[cfg(not(target_os = "macos"))]
    set_native_window_level(window, 0);
}

fn set_bubble_window_level(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    set_native_window_level(window, objc2_app_kit::NSStatusWindowLevel + 1);
    #[cfg(not(target_os = "macos"))]
    set_native_window_level(window, 0);
}

#[cfg(target_os = "macos")]
fn first_mouse_window_class() -> &'static objc2::runtime::AnyClass {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{msg_send, sel};

    extern "C-unwind" fn send_event(_this: &AnyObject, _cmd: Sel, event: &AnyObject) {
        let event_type: usize = unsafe { msg_send![event, type] };
        if matches!(event_type, 1 | 3) {
            let is_key: Bool = unsafe { msg_send![_this, isKeyWindow] };
            if !is_key.as_bool() {
                let _: () = unsafe { msg_send![_this, makeKeyWindow] };
            }
        }
        let superclass = objc2::class!(NSWindow);
        let _: () = unsafe { msg_send![super(_this, superclass), sendEvent: event] };
    }

    extern "C-unwind" fn can_become_key_window(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::YES
    }

    extern "C-unwind" fn can_become_main_window(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::YES
    }

    let class_name = c"HermesFirstClickWindow";
    if let Some(existing) = AnyClass::get(class_name) {
        return existing;
    }
    let mut builder = ClassBuilder::new(class_name, objc2::class!(NSWindow))
        .expect("failed to allocate first-click window class");
    unsafe {
        builder.add_method(
            sel!(sendEvent:),
            send_event as extern "C-unwind" fn(_, _, _),
        );
        builder.add_method(
            sel!(canBecomeKeyWindow),
            can_become_key_window as extern "C-unwind" fn(_, _) -> _,
        );
        builder.add_method(
            sel!(canBecomeMainWindow),
            can_become_main_window as extern "C-unwind" fn(_, _) -> _,
        );
    }
    builder.register()
}

#[cfg(target_os = "macos")]
fn install_first_click_handler(window: &WebviewWindow) {
    use objc2::runtime::AnyObject;

    if let Ok(ptr) = window.ns_window() {
        if !ptr.is_null() {
            let ns_window: &AnyObject = unsafe { &*ptr.cast() };
            let current_name = ns_window.class().name().to_string_lossy();
            if current_name.as_ref() != "HermesFirstClickWindow" {
                let next_class = first_mouse_window_class();
                unsafe {
                    let _ = AnyObject::set_class(ns_window, next_class);
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn install_first_click_handler(_window: &WebviewWindow) {}

#[cfg(target_os = "macos")]
fn attach_bubble_child_window(pet_window: &WebviewWindow, bubble_window: &WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    let Ok(pet_ptr) = pet_window.ns_window() else {
        return;
    };
    let Ok(bubble_ptr) = bubble_window.ns_window() else {
        return;
    };
    if pet_ptr.is_null() || bubble_ptr.is_null() {
        return;
    }
    let pet_ns_window: &NSWindow = unsafe { &*pet_ptr.cast() };
    let bubble_ns_window: &NSWindow = unsafe { &*bubble_ptr.cast() };
    unsafe {
        pet_ns_window.addChildWindow_ordered(bubble_ns_window, NSWindowOrderingMode::Above);
    }
}

#[cfg(not(target_os = "macos"))]
fn attach_bubble_child_window(_pet_window: &WebviewWindow, _bubble_window: &WebviewWindow) {}

fn restore_pet_window_layers(app: &tauri::AppHandle) {
    if let Some(pet_window) = app.get_webview_window("pet") {
        let _ = pet_window.set_ignore_cursor_events(false);
        set_native_ignore_cursor_events(&pet_window, false);
        let _ = pet_window.set_always_on_top(false);
        let _ = pet_window.set_always_on_top(true);
        set_pet_window_level(&pet_window);
        install_first_click_handler(&pet_window);
    }
    if let Some(bubble_window) = app.get_webview_window("pet_bubbles") {
        let _ = bubble_window.set_always_on_top(false);
        let _ = bubble_window.set_always_on_top(true);
        set_bubble_window_level(&bubble_window);
        install_first_click_handler(&bubble_window);
    }
}

fn restore_pet_window_layers_later(app: tauri::AppHandle, delay: Duration) {
    thread::spawn(move || {
        thread::sleep(delay);
        let handle_for_window = app.clone();
        let _ = app.run_on_main_thread(move || restore_pet_window_layers(&handle_for_window));
    });
}

fn restore_pet_window_layers_during_startup(app: tauri::AppHandle) {
    for delay in [
        Duration::from_millis(80),
        Duration::from_millis(300),
        Duration::from_millis(1200),
    ] {
        restore_pet_window_layers_later(app.clone(), delay);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetRaisePayload {
    visible: Option<bool>,
    focus: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetAttentionUpdatePayload {
    count: Option<u64>,
    collapsed: Option<bool>,
}

fn parse_attention_visibility(payload: &str) -> bool {
    serde_json::from_str::<PetAttentionUpdatePayload>(payload)
        .map(|item| item.count.unwrap_or(0) > 0 && !item.collapsed.unwrap_or(false))
        .unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetContextMenuPayload {
    skins: Vec<PetSkin>,
    active_skin_id: Option<String>,
    active_bubble_style: Option<String>,
    permissions: Option<PetPermissionsPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct PetPermissionsPayload {
    allow_direct_send: Option<bool>,
    allow_inline_action_responses: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetPermissionTogglePayload {
    key: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetSkin {
    id: String,
    display_name: String,
}

fn desktop_pet_webui_base() -> String {
    let raw = std::env::var("HERMES_DESKTOP_PET_WEBUI_BASE")
        .or_else(|_| std::env::var("HERMES_DESKTOP_COMPANION_BASE"))
        .unwrap_or_else(|_| "http://127.0.0.1:17787".into());
    let trimmed = raw.trim().trim_end_matches('/');
    if let Ok(url) = Url::parse(trimmed) {
        let scheme_ok = matches!(url.scheme(), "http" | "https");
        let host_ok = matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("::1")
        );
        if scheme_ok && host_ok {
            return trimmed.to_string();
        }
    }
    "http://127.0.0.1:17787".into()
}

fn navigate_window_to_webui(app: &tauri::App, label: &str, path: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let base = desktop_pet_webui_base();
    let Ok(mut url) = Url::parse(&format!("{}{}", base, path)) else {
        return;
    };
    url.query_pairs_mut()
        .append_pair("desktop_pet_pid", &process::id().to_string());
    let _ = window.navigate(url);
}

fn open_external_url(url: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("explorer").arg(url).spawn();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}

fn remote_webui_url() -> String {
    std::env::var("HERMES_DESKTOP_PET_WEBUI_BASE")
        .ok()
        .map(|raw| raw.trim().trim_end_matches('/').to_string())
        .filter(|trimmed| !trimmed.is_empty())
        .unwrap_or_else(|| "https://hermes.meruru.ccwu.cc".into())
}

fn open_pet_gallery_manager(_app: &tauri::AppHandle) {
    let base = desktop_pet_webui_base();
    open_external_url(&format!("{}/pet/gallery", base));
}

fn apply_bubble_visibility(
    app: &tauri::AppHandle,
    visible_state: &Arc<Mutex<bool>>,
    visible: bool,
    focus: bool,
) {
    if let Ok(mut state) = visible_state.lock() {
        *state = visible;
    }
    let Some(bubble_window) = app.get_webview_window("pet_bubbles") else {
        return;
    };
    let _ = bubble_window.set_ignore_cursor_events(!visible);
    set_native_ignore_cursor_events(&bubble_window, !visible);
    if visible {
        let _ = bubble_window.set_always_on_top(true);
        set_bubble_window_level(&bubble_window);
        install_first_click_handler(&bubble_window);
        let _ = bubble_window.show();
        if focus {
            let _ = bubble_window.set_focus();
        }
    } else {
        let _ = bubble_window.hide();
    }
}

fn fallback_skins() -> Vec<PetSkin> {
    vec![
        PetSkin {
            id: "keeper".into(),
            display_name: "May".into(),
        },
        PetSkin {
            id: "shiba".into(),
            display_name: "shiba".into(),
        },
    ]
}

fn pet_context_menu_payload(payload: &str) -> PetContextMenuPayload {
    serde_json::from_str(payload).unwrap_or_else(|_| PetContextMenuPayload {
        skins: fallback_skins(),
        active_skin_id: Some("keeper".into()),
        active_bubble_style: None,
        permissions: None,
    })
}

const TRAY_TOGGLE_ID: &str = "tray_toggle_pet";
const TRAY_OPEN_WEBUI_ID: &str = "tray_open_webui";
const TRAY_QUIT_ID: &str = "tray_quit";

fn build_tray(app: &tauri::AppHandle, user_hidden: Arc<AtomicBool>) -> Result<(), tauri::Error> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_TOGGLE_ID, "Show/Hide pet")
        .text(TRAY_OPEN_WEBUI_ID, "Open WebUI")
        .separator()
        .text(TRAY_QUIT_ID, "Quit")
        .build()?;
    // 显式设置托盘图标：不依赖 default_window_icon（Windows 上可能为 None 导致托盘空白）
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|err| tauri::Error::Anyhow(err.into()))?;
    TrayIconBuilder::with_id("main")
        .icon(tray_icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            TRAY_TOGGLE_ID => {
                let handle = app.clone();
                let window_handle = handle.clone();
                let hidden_state = user_hidden.clone();
                let _ = handle.run_on_main_thread(move || {
                    let show = if hidden_state.load(Ordering::SeqCst) {
                        true
                    } else {
                        window_handle
                            .get_webview_window("pet")
                            .map(|window| !window.is_visible().unwrap_or(false))
                            .unwrap_or(false)
                    };
                    hidden_state.store(!show, Ordering::SeqCst);
                    emit_pet_visibility(&window_handle, show);
                    for label in ["pet", "pet_bubbles"] {
                        if let Some(window) = window_handle.get_webview_window(label) {
                            if show {
                                let _ = window.show();
                            } else {
                                let _ = window.hide();
                            }
                        }
                    }
                });
            }
            TRAY_OPEN_WEBUI_ID => open_external_url(&remote_webui_url()),
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}


fn valid_skin_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn sanitize_skin(skin: PetSkin) -> Option<PetSkin> {
    if !valid_skin_id(&skin.id) {
        return None;
    }
    let display_name = skin
        .display_name
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(64)
        .collect::<String>();
    Some(PetSkin {
        id: skin.id,
        display_name: if display_name.is_empty() {
            "skin".into()
        } else {
            display_name
        },
    })
}

fn main() {
    #[cfg(target_os = "windows")]
    let Some(_instance_mutex) = (|| {
        let restarting = std::env::var_os("HERMES_COMPANION_RESTARTING").is_some();
        for _ in 0..=31 {
            if let Some(mutex) = acquire_single_instance() {
                return Some(mutex);
            }
            if !restarting {
                return None;
            }
            // 重启路径：旧进程正在退出（500ms 后 exit 释放互斥），等待重试而非直接关闭
            thread::sleep(Duration::from_millis(100));
        }
        None
    })()
    else {
        return;
    };

    let restart_requested = Arc::new(AtomicBool::new(false));
    let restart_requested_for_setup = restart_requested.clone();
    let restart_requested_for_menu = restart_requested.clone();
    let bubble_visible_state = Arc::new(Mutex::new(false));
    let bubble_visible_state_for_setup = bubble_visible_state.clone();
    let user_hidden = Arc::new(AtomicBool::new(false));
    let user_hidden_for_setup = user_hidden.clone();
    let user_hidden_for_tray = user_hidden.clone();
    tauri::Builder::default()
        .setup(move |app| {
            let sidecar = Sidecar::start().map_err(|error| error.to_string())?;
            app.manage(sidecar);
            build_tray(app.handle(), user_hidden_for_tray.clone())?;

            navigate_window_to_webui(app, "pet", "/pet");
            navigate_window_to_webui(app, "pet_bubbles", "/pet/bubbles");
            if let Some(pet_window) = app.get_webview_window("pet") {
                let _ = pet_window.set_ignore_cursor_events(false);
                set_native_ignore_cursor_events(&pet_window, false);
                let _ = pet_window.set_always_on_top(true);
                set_pet_window_level(&pet_window);
                install_first_click_handler(&pet_window);
            }
            if let Some(bubble_window) = app.get_webview_window("pet_bubbles") {
                let _ = bubble_window.set_ignore_cursor_events(true);
                set_native_ignore_cursor_events(&bubble_window, true);
                let _ = bubble_window.set_always_on_top(true);
                set_bubble_window_level(&bubble_window);
                install_first_click_handler(&bubble_window);
            }
            if let (Some(pet_window), Some(bubble_window)) = (
                app.get_webview_window("pet"),
                app.get_webview_window("pet_bubbles"),
            ) {
                attach_bubble_child_window(&pet_window, &bubble_window);
            }
            restore_pet_window_layers_during_startup(app.handle().clone());
            let raise_handle = app.handle().clone();
            let raise_visible_state = bubble_visible_state_for_setup.clone();
            let raise_user_hidden = user_hidden_for_setup.clone();
            app.listen(PET_RAISE_REQUESTED_EVENT, move |event| {
                let handle = raise_handle.clone();
                let window_handle = handle.clone();
                let runner_handle = handle.clone();
                let control_handle = handle.clone();
                let visible_state = raise_visible_state.clone();
                let payload = serde_json::from_str::<PetRaisePayload>(event.payload()).ok();
                let visible = payload
                    .as_ref()
                    .and_then(|payload| payload.visible)
                    .unwrap_or(true);
                if raise_user_hidden.load(Ordering::SeqCst) && visible {
                    return;
                }
                let focus = payload
                    .as_ref()
                    .and_then(|payload| payload.focus)
                    .unwrap_or(false);
                let hidden_state = raise_user_hidden.clone();
                let _ = runner_handle.run_on_main_thread(move || {
                    apply_bubble_visibility(&control_handle, &visible_state, visible, focus);
                    if let Some(window) = window_handle.get_webview_window("pet") {
                        let _ = window.set_ignore_cursor_events(false);
                        set_native_ignore_cursor_events(&window, false);
                        set_pet_window_level(&window);
                        install_first_click_handler(&window);
                        if !hidden_state.load(Ordering::SeqCst) {
                            let _ = window.show();
                        }
                    }
                });
            });
            let app_handle = app.handle().clone();
            let attention_visible_state = bubble_visible_state_for_setup.clone();
            let attention_user_hidden = user_hidden_for_setup.clone();
            app.listen("pet-attention-update", move |event| {
                let handle = app_handle.clone();
                let visible = parse_attention_visibility(event.payload());
                if attention_user_hidden.load(Ordering::SeqCst) && visible {
                    return;
                }
                let handle_for_window = handle.clone();
                let visible_state = attention_visible_state.clone();
                let should_apply = visible_state
                    .lock()
                    .map(|state| *state != visible)
                    .unwrap_or(true);
                let _ = handle.run_on_main_thread(move || {
                    if should_apply {
                        apply_bubble_visibility(&handle_for_window, &visible_state, visible, false);
                    }
                });
            });
            let restart_requested = restart_requested_for_setup.clone();
            app.listen(PET_NATIVE_RESTART_REQUESTED_EVENT, move |_| {
                if restart_requested.swap(true, Ordering::SeqCst) {
                    return;
                }
                thread::spawn(_restart_native_process);
            });
            let handle = app.handle().clone();
            app.listen(PET_CONTEXT_MENU_EVENT, move |event| {
                let payload = pet_context_menu_payload(event.payload());
                let handle = handle.clone();
                let menu_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let Some(window) = menu_handle.get_webview_window("pet") else {
                        return;
                    };
                    lower_pet_windows_for_menu(&menu_handle);
                    let mut skin_builder = SubmenuBuilder::new(&menu_handle, "Switch skin");
                    let active_skin_id = payload
                        .active_skin_id
                        .as_deref()
                        .filter(|id| valid_skin_id(id))
                        .unwrap_or("keeper");
                    let mut skins: Vec<PetSkin> = payload
                        .skins
                        .into_iter()
                        .filter_map(sanitize_skin)
                        .collect();
                    if skins.is_empty() {
                        skins = fallback_skins();
                    }
                    for skin in skins {
                        let mut label = skin.display_name;
                        if skin.id == active_skin_id {
                            label = format!("{} ✓", label);
                        }
                        skin_builder =
                            skin_builder.text(format!("{SKIN_MENU_PREFIX}{}", skin.id), label);
                    }
                    let Ok(skin_menu) = skin_builder.build() else {
                        return;
                    };
                    let active_bubble_style = payload
                        .active_bubble_style
                        .as_deref()
                        .filter(|style| matches!(*style, "default" | "chatgpt" | "chatgpt-dark"))
                        .unwrap_or("default");
                    let bubble_style_label = |name: &str, label: &str| {
                        if name == active_bubble_style {
                            format!("{label} ✓")
                        } else {
                            label.to_string()
                        }
                    };
                    let Ok(style_menu) = SubmenuBuilder::new(&menu_handle, "Bubble style")
                        .text(
                            format!("{BUBBLE_STYLE_PREFIX}default"),
                            bubble_style_label("default", "Classic"),
                        )
                        .text(
                            format!("{BUBBLE_STYLE_PREFIX}chatgpt"),
                            bubble_style_label("chatgpt", "ChatGPT Light"),
                        )
                        .text(
                            format!("{BUBBLE_STYLE_PREFIX}chatgpt-dark"),
                            bubble_style_label("chatgpt-dark", "ChatGPT Dark"),
                        )
                        .build()
                    else {
                        return;
                    };
                    let allow_direct_send = payload
                        .permissions
                        .as_ref()
                        .and_then(|item| item.allow_direct_send)
                        .unwrap_or(false);
                    let allow_inline_action_responses = payload
                        .permissions
                        .as_ref()
                        .and_then(|item| item.allow_inline_action_responses)
                        .unwrap_or(false);
                    let Ok(permission_menu) =
                        SubmenuBuilder::new(&menu_handle, "Permissions")
                            .text(
                                format!(
                                    "{PERMISSION_MENU_PREFIX}allow_direct_send:{}",
                                    !allow_direct_send
                                ),
                                if allow_direct_send {
                                    "Allow direct send ✓".to_string()
                                } else {
                                    "Allow direct send".to_string()
                                },
                            )
                            .text(
                                format!(
                                    "{PERMISSION_MENU_PREFIX}allow_inline_action_responses:{}",
                                    !allow_inline_action_responses
                                ),
                                if allow_inline_action_responses {
                                    "Allow approval / clarify responses ✓".to_string()
                                } else {
                                    "Allow approval / clarify responses".to_string()
                                },
                            )
                            .build()
                    else {
                        return;
                    };
                    let Ok(menu) = MenuBuilder::new(&menu_handle)
                        .item(&skin_menu)
                        .item(&style_menu)
                        .text(MANAGE_PETS_MENU_ID, "Manage pets...")
                        .separator()
                        .item(&permission_menu)
                        .separator()
                        .text(RESTART_PET_MENU_ID, "Restart pet")
                        .text(CLOSE_PET_MENU_ID, "Close pet")
                        .build()
                    else {
                        return;
                    };
                    let _ = window.popup_menu(&menu);
                    restore_pet_window_layers_later(menu_handle.clone(), Duration::from_secs(12));
                });
            });
            Ok(())
        })
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            if let Some(skin_id) = id.strip_prefix(SKIN_MENU_PREFIX) {
                if !valid_skin_id(skin_id) {
                    return;
                }
                let skin_id = skin_id.to_string();
                let _ = app.emit_to("pet", PET_SKIN_CHANGE_EVENT, skin_id.clone());
                let _ = app.emit_to("pet_bubbles", PET_SKIN_CHANGE_EVENT, skin_id);
                restore_pet_window_layers(&app.clone());
                return;
            }
            if let Some(style) = id.strip_prefix(BUBBLE_STYLE_PREFIX) {
                if matches!(style, "default" | "chatgpt" | "chatgpt-dark") {
                    restore_pet_window_layers(&app.clone());
                    let _ = app.emit_to("pet", PET_BUBBLE_STYLE_CHANGE_EVENT, style.to_string());
                    let _ = app.emit_to("pet_bubbles", PET_BUBBLE_STYLE_CHANGE_EVENT, style.to_string());
                }
                return;
            }
            if let Some(raw) = id.strip_prefix(PERMISSION_MENU_PREFIX) {
                let mut parts = raw.split(':');
                let Some(key) = parts.next() else {
                    return;
                };
                let Some(enabled_text) = parts.next() else {
                    return;
                };
                if !matches!(key, "allow_direct_send" | "allow_inline_action_responses") {
                    return;
                }
                let enabled = enabled_text == "true";
                let payload = PetPermissionTogglePayload {
                    key: key.to_string(),
                    enabled,
                };
                restore_pet_window_layers(&app.clone());
                let _ = app.emit_to("pet", PET_PERMISSION_TOGGLE_EVENT, payload.clone());
                let _ = app.emit_to("pet_bubbles", PET_PERMISSION_TOGGLE_EVENT, payload);
                return;
            }
            match id {
                CLOSE_PET_MENU_ID => {
                    _persist_desktop_pet_preference(&app.clone(), false);
                    let exit_handle = app.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(220));
                        exit_handle.exit(0);
                    });
                }
                MANAGE_PETS_MENU_ID => {
                    restore_pet_window_layers(&app.clone());
                    open_pet_gallery_manager(&app.clone());
                }
                RESTART_PET_MENU_ID => {
                    restore_pet_window_layers(&app.clone());
                    let _ = app.emit_to("pet", PET_RESTART_REQUESTED_EVENT, ());
                    let _ = app.emit_to("pet_bubbles", PET_RESTART_REQUESTED_EVENT, ());
                    let app_for_fallback = app.clone();
                    let should_restart = restart_requested_for_menu.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(260));
                        if should_restart.swap(true, Ordering::SeqCst) {
                            return;
                        }
                        let _ = app_for_fallback.emit_to("pet", PET_RESTART_REQUESTED_EVENT, ());
                        _restart_native_process();
                    });
                }
                _ => {
                    restore_pet_window_layers(&app.clone());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Hermes desktop pet");
}
