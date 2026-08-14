//! OS-level notifications that attribute the toast to this app ("DevOps Station")
//! instead of falling back to "Windows PowerShell".
//!
//! Why this module exists: `tauri-plugin-notification`'s Windows backend
//! deliberately skips setting the toast's AppUserModelID when the binary lives
//! under `target/debug` or `target/release` (i.e. `tauri dev`). Without an
//! AUMID the OS attributes the toast to the console host that launched the app —
//! which is why every notification showed up as "Windows PowerShell" regardless
//! of which terminal session triggered it.
//!
//! For a Win32 (non-packaged) app to show a toast under its OWN AUMID, Windows
//! requires BOTH:
//!   1. the current process to declare its AUMID via
//!      `SetCurrentProcessExplicitAppUserModelID`, AND
//!   2. a Start Menu shortcut carrying that AUMID (else the toast is *silently
//!      dropped* — `show()` still returns Ok, so it can't be detected).
//! We do both in `register_aumid()`, called once at startup.

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};

/// Must match `identifier` in `tauri.conf.json` and the AUMID the installer
/// writes onto the Start Menu shortcut.
#[cfg(windows)]
pub const APP_AUMID: &str = "dev.hones.devops-station";

/// Set once the process AUMID + Start Menu shortcut are in place. Until then we
/// deliberately send the toast WITHOUT a custom app_id so it still shows (under
/// "Windows PowerShell") instead of being silently dropped.
#[cfg(windows)]
static AUMID_READY: AtomicBool = AtomicBool::new(false);

/// Register our AUMID so toasts attribute to this app. Call once at startup
/// (from `setup`), before any notification can fire. Safe to call repeatedly.
pub fn register_aumid() {
    #[cfg(windows)]
    {
        // (1) Declare the AUMID on the current process (direct shell32 call).
        unsafe {
            use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
            let _ = SetCurrentProcessExplicitAppUserModelID(&windows::core::HSTRING::from(APP_AUMID));
        }

        // (2) Ensure a Start Menu shortcut carries the same AUMID.
        if let Some(lnk) = shortcut_path() {
            if lnk.exists() {
                AUMID_READY.store(true, Ordering::SeqCst);
            } else {
                // Run on a dedicated thread so the COM apartment model can't clash
                // with Tauri's main/worker threads (a clash would make every COM
                // call fail and the shortcut silently never get created).
                let path = lnk.clone();
                let handle = std::thread::spawn(move || match create_shortcut(&path) {
                    Ok(()) => {
                        eprintln!("[notify] registered AUMID shortcut: {}", path.display());
                        AUMID_READY.store(true, Ordering::SeqCst);
                    }
                    Err(e) => eprintln!("[notify] failed to create Start Menu shortcut: {e:?}"),
                });
                let _ = handle.join();
            }
        }
    }
}

/// Strip C0 control characters before handing the text to the WinRT toast
/// pipeline. notify-rust 4.x *already* XML-escapes the text internally when
/// building the toast XML payload, so doing `&`/`<`/`>` escaping here would
/// double-escape and surface `&amp;apos;` literally in the toast. We therefore
/// only strip the C0 control codes that are illegal in XML 1.0 (BEL, backspace,
/// stray nulls, …) and leave the printable characters — including `&`, `<`,
/// `>` and `'` — for notify-rust to handle.
///
/// Why this exists at all: raw terminal output can carry BEL/`\x07`/BS/`\x08`
/// that survive `stripAnsi` in `perm.rs`; the WinRT toast builder raises
/// HRESULT 0xC00CE508 ("invalid characters in text") when it sees them,
/// causing every approval notification to fall back to the slower Tauri
/// plugin path. Filtering here keeps the attributed toast working.
fn sanitize_text(s: &str) -> String {
    s.chars()
        .filter(|&c| (c as u32) >= 0x20 || c == '\n' || c == '\r')
        .collect()
}

/// Raise an OS notification, attributed to this app when our AUMID is registered.
///
/// If the AUMID isn't ready we still send the toast without a custom app_id so it
/// shows under "Windows PowerShell" rather than being silently dropped. And if the
/// WinRT call errors for any reason we fall back to the Tauri plugin. We never
/// want a permission prompt to go completely unnoticed.
pub fn show(app: &tauri::AppHandle, title: &str, body: &str) {
    let title = sanitize_text(title);
    let body = sanitize_text(body);
    #[cfg(windows)]
    {
        if AUMID_READY.load(Ordering::SeqCst) {
            // Appropriately attributed toast (shows under "DevOps Station" in
            // Action Center). With a valid AUMID, WinRT failures are real
            // errors, so fall back to the plugin on Err.
            let mut n = notify_rust::Notification::new();
            n.summary(&title).body(&body).app_id(APP_AUMID);
            if let Err(e) = n.show() {
                eprintln!("[notify] attributed toast failed: {e:?}; falling back to plugin");
                try_plugin(app, &title, &body);
            }
        } else {
            // No Start Menu shortcut carrying our AUMID → a WinRT toast without
            // an AUMID is *silently dropped* by Windows (show() returns Ok, so
            // we'd never notice). Skip notify_rust entirely and use the Tauri
            // plugin, whose WinRT path may still surface, and at least errors
            // loudly instead of dropping.
            eprintln!("[notify] AUMID not ready (no Start Menu shortcut); routing toast to Tauri plugin");
            try_plugin(app, &title, &body);
        }
    }
    #[cfg(not(windows))]
    {
        try_plugin(app, &title, &body);
    }
}

/// Last-resort toast via `tauri-plugin-notification`. Logs (never panics) on
/// failure so a broken notification can't take down the caller.
fn try_plugin(app: &tauri::AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[notify] Tauri plugin toast failed: {e:?}");
    }
}

#[cfg(windows)]
fn shortcut_path() -> Option<std::path::PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let mut p = std::path::PathBuf::from(appdata);
    p.push("Microsoft");
    p.push("Windows");
    p.push("Start Menu");
    p.push("Programs");
    p.push("DevOps Station.lnk");
    Some(p)
}

#[cfg(windows)]
fn create_shortcut(lnk: &std::path::Path) -> windows::core::Result<()> {
    use std::mem;

    use std::mem::ManuallyDrop;

    use windows::core::HSTRING;
    use windows::core::Interface;
    use windows::core::PWSTR;
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
    use windows::Win32::System::Com::CoCreateInstance;
    use windows::Win32::System::Com::CoInitializeEx;
    use windows::Win32::System::Com::CLSCTX_ALL;
    use windows::Win32::System::Com::COINIT_APARTMENTTHREADED;
    use windows::Win32::System::Com::COINIT_DISABLE_OLE1DDE;
    use windows::Win32::System::Com::IPersistFile;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0_0;
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::IShellLinkW;
    use windows::Win32::UI::Shell::PropertiesSystem::GPS_READWRITE;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::PropertiesSystem::SHGetPropertyStoreFromParsingName;
    use windows::Win32::UI::Shell::ShellLink;

    unsafe {
        // Best-effort; ignore the result (S_OK / S_FALSE both mean COM is usable,
        // and RPC_E_CHANGED_MODE means it's already up in another mode — either
        // way the calls below still work).
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);

        if let Some(parent) = lnk.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let exe = std::env::current_exe()?;
        let exe_h = HSTRING::from(exe.to_string_lossy().as_ref());
        let lnk_h = HSTRING::from(lnk.to_string_lossy().as_ref());

        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_ALL)?;
        link.SetPath(&exe_h)?;
        link.SetDescription(&HSTRING::from("DevOps Station"))?;
        link.SetIconLocation(&exe_h, 0)?;

        // Save the .lnk FILE to the Start Menu path (not to the exe path!).
        let persist: IPersistFile = link.cast()?;
        persist.Save(&lnk_h, true)?;

        // Stamp our AUMID onto the saved .lnk file's property store so the OS
        // knows this AUMID belongs to our app (name + icon in Action Center).
        let store: IPropertyStore =
            SHGetPropertyStoreFromParsingName(&lnk_h, None, GPS_READWRITE)?;

        // Keep the UTF-16 buffer alive across SetValue + Commit.
        let mut aumid_w: Vec<u16> =
            APP_AUMID.encode_utf16().chain(std::iter::once(0)).collect();
        let pv = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_LPWSTR,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        pwszVal: PWSTR(aumid_w.as_mut_ptr()),
                    },
                }),
            },
        };
        store.SetValue(&PKEY_AppUserModel_ID, &pv)?;
        store.Commit()?;
        // The property store copies the string, so the PROPVARIANT's pointer is
        // no longer needed. `PROPVARIANT`'s Drop calls `PropVariantClear`, which
        // for VT_LPWSTR would `CoTaskMemFree` our Rust-allocated buffer — so
        // forget the struct (leak the tiny stack value) and let the Vec free
        // itself.
        mem::forget(pv);
        mem::drop(aumid_w);
        Ok(())
    }
}
