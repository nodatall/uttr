#ifndef app_activation_monitor_bridge_h
#define app_activation_monitor_bridge_h

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*UttrAppActivationCallback)(void);

int32_t uttr_app_activation_monitor_start(UttrAppActivationCallback callback);
void uttr_app_activation_monitor_stop(void);

#ifdef __cplusplus
}
#endif

#endif /* app_activation_monitor_bridge_h */
