import AppKit
import Foundation

private let activationMonitorLock = NSLock()
private var activationObserver: NSObjectProtocol?
private var wakeObserver: NSObjectProtocol?
private var screensWakeObserver: NSObjectProtocol?
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
    if let observer = wakeObserver {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
        wakeObserver = nil
    }
    if let observer = screensWakeObserver {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
        screensWakeObserver = nil
    }

    activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didActivateApplicationNotification,
        object: nil,
        queue: nil
    ) { _ in
        activationCallback?()
    }
    wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didWakeNotification,
        object: nil,
        queue: nil
    ) { _ in
        activationCallback?()
    }
    screensWakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.screensDidWakeNotification,
        object: nil,
        queue: nil
    ) { _ in
        activationCallback?()
    }

    return activationObserver == nil && wakeObserver == nil && screensWakeObserver == nil ? 0 : 1
}

@_cdecl("uttr_app_activation_monitor_stop")
func uttr_app_activation_monitor_stop() {
    activationMonitorLock.lock()
    defer { activationMonitorLock.unlock() }

    if let observer = activationObserver {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
        activationObserver = nil
    }
    if let observer = wakeObserver {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
        wakeObserver = nil
    }
    if let observer = screensWakeObserver {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
        screensWakeObserver = nil
    }

    activationCallback = nil
}
