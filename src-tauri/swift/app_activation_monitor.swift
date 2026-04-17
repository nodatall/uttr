import AppKit
import Foundation

private let activationMonitorLock = NSLock()
private var activationObservers: [NSObjectProtocol] = []
private var activationCallback: UttrAppActivationCallback?

@_cdecl("uttr_app_activation_monitor_start")
func uttr_app_activation_monitor_start(_ callback: UttrAppActivationCallback?) -> Int32 {
    activationMonitorLock.lock()
    defer { activationMonitorLock.unlock() }

    activationCallback = callback

    for observer in activationObservers {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
    }
    activationObservers.removeAll()

    let notificationNames: [NSWorkspace.Notification.Name] = [
        NSWorkspace.didActivateApplicationNotification,
        NSWorkspace.didWakeNotification,
        NSWorkspace.screensDidWakeNotification,
    ]

    for notificationName in notificationNames {
        let observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: notificationName,
            object: nil,
            queue: nil
        ) { _ in
            activationCallback?()
        }
        activationObservers.append(observer)
    }

    return activationObservers.isEmpty ? 0 : 1
}

@_cdecl("uttr_app_activation_monitor_stop")
func uttr_app_activation_monitor_stop() {
    activationMonitorLock.lock()
    defer { activationMonitorLock.unlock() }

    for observer in activationObservers {
        NSWorkspace.shared.notificationCenter.removeObserver(observer)
    }
    activationObservers.removeAll()

    activationCallback = nil
}
