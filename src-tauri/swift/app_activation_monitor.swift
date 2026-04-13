import AppKit
import Foundation

private let activationMonitorLock = NSLock()
private var activationObserver: NSObjectProtocol?
private var activationCallback: UttrAppActivationCallback?

@_cdecl("uttr_app_activation_monitor_start")
func uttr_app_activation_monitor_start(_ callback: UttrAppActivationCallback?) -> Int32 {
    activationMonitorLock.lock()
    defer { activationMonitorLock.unlock() }

    activationCallback = callback

    if let observer = activationObserver {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
        activationObserver = nil
    }

    activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didActivateApplicationNotification,
        object: nil,
        queue: nil
    ) { _ in
        activationCallback?()
    }

    return activationObserver == nil ? 0 : 1
}

@_cdecl("uttr_app_activation_monitor_stop")
func uttr_app_activation_monitor_stop() {
    activationMonitorLock.lock()
    defer { activationMonitorLock.unlock() }

    if let observer = activationObserver {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
        activationObserver = nil
    }

    activationCallback = nil
}
