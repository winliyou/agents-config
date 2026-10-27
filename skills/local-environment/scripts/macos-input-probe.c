// macos-input-probe.c —— macOS 鼠标/键盘事件取证（只读，不注入任何事件）
// 用法: clang 本文件 -o /tmp/input-probe -framework CoreGraphics -framework CoreFoundation && /tmp/input-probe
// 输出: 全部 CGEventTap(位置/能否拦截/监听掩码) + HID与Session两层按键状态与最近事件时间 + 全部窗口(进程/层级/屏上/透明/几何)
// 实测: 2026-10-25, clang@macOS CLT, 编译需同时链 CoreGraphics 与 CoreFoundation
#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  UInt32 count = 0;
  CGGetEventTapList(0, NULL, &count);
  CGEventTapInformation *taps = (CGEventTapInformation *)calloc(count ? count : 1, sizeof(CGEventTapInformation));
  UInt32 got = 0;
  CGGetEventTapList(count, taps, &got);
  printf("MARK_taps_begin count=%u\n", got);
  for (UInt32 i = 0; i < got; i++) {
    unsigned int *w = (unsigned int *)&taps[i];
    printf("TAP id=%u loc=%d opt=%d mask=0x%016llx words=%u %u %u %u %u %u %u %u\n",
      taps[i].eventTapID, (int)taps[i].tapPoint, (int)taps[i].options,
      (unsigned long long)taps[i].eventsOfInterest,
      w[0],w[1],w[2],w[3],w[4],w[5],w[6],w[7]);
  }
  printf("MARK_button_state\n");
  printf("combined: left=%d right=%d\n",
    CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft),
    CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState, kCGMouseButtonRight));
  printf("hid: left=%d right=%d\n",
    CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonLeft),
    CGEventSourceButtonState(kCGEventSourceStateHIDSystemState, kCGMouseButtonRight));
  printf("MARK_since_last\n");
  printf("combined: L-up=%.1fs L-down=%.1fs keyDown=%.1fs\n",
    (double)CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventLeftMouseUp),
    (double)CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventLeftMouseDown),
    (double)CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, kCGEventKeyDown));
  printf("hid: L-up=%.1fs L-down=%.1fs keyDown=%.1fs\n",
    (double)CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGEventLeftMouseUp),
    (double)CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGEventLeftMouseDown),
    (double)CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGEventKeyDown));
  printf("MARK_windows_begin\n");
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  if (!list) { printf("window_list_null\n"); return 0; }
  CFIndex n = CFArrayGetCount(list);
  printf("window_count=%ld\n", (long)n);
  for (CFIndex i = 0; i < n; i++) {
    CFDictionaryRef wd = CFArrayGetValueAtIndex(list, i);
    int pid = 0, layer = 0; double alpha = 1; int on = 0;
    CFNumberRef r;
    if ((r = CFDictionaryGetValue(wd, kCGWindowOwnerPID))) CFNumberGetValue(r, kCFNumberIntType, &pid);
    if ((r = CFDictionaryGetValue(wd, kCGWindowLayer))) CFNumberGetValue(r, kCFNumberIntType, &layer);
    if ((r = CFDictionaryGetValue(wd, kCGWindowAlpha))) { double d; if (CFNumberGetValue(r, kCFNumberDoubleType, &d)) alpha = d; }
    CFBooleanRef b = CFDictionaryGetValue(wd, kCGWindowIsOnscreen);
    if (b) on = CFBooleanGetValue(b) ? 1 : 0;
    CGRect bounds = CGRectNull;
    CFDictionaryRef bd = CFDictionaryGetValue(wd, kCGWindowBounds);
    if (bd) CGRectMakeWithDictionaryRepresentation(bd, &bounds);
    char owner[96] = "-", name[96] = "-";
    CFStringRef s;
    if ((s = CFDictionaryGetValue(wd, kCGWindowOwnerName))) CFStringGetCString(s, owner, 95, kCFStringEncodingUTF8);
    if ((s = CFDictionaryGetValue(wd, kCGWindowName))) CFStringGetCString(s, name, 95, kCFStringEncodingUTF8);
    printf("WIN pid=%d layer=%d on=%d alpha=%.2f x=%.0f y=%.0f w=%.0f h=%.0f owner=%s name=%s\n",
      pid, layer, on, alpha, bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height, owner, name);
  }
  return 0;
}