// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// DOM KeyboardEvent.code ↔ Windows scan code (set 1), 0xE0xx = extended key.
// Values follow Chromium's keycode_converter table (US/ISO/JIS physical positions).
using System.Collections.Generic;

namespace MacShare
{
    static class Keys
    {
        static readonly Dictionary<string, int> ToScan = new Dictionary<string, int>();
        static readonly Dictionary<int, string> ToCode = new Dictionary<int, string>();

        static void Add(string code, int scan)
        {
            ToScan[code] = scan;
            if (!ToCode.ContainsKey(scan)) ToCode[scan] = code;
        }

        static Keys()
        {
            Add("Escape", 0x01);
            string digits = "1234567890";
            for (int i = 0; i < 10; i++) Add("Digit" + digits[i], 0x02 + i);
            Add("Minus", 0x0C); Add("Equal", 0x0D); Add("Backspace", 0x0E); Add("Tab", 0x0F);
            string row1 = "QWERTYUIOP";
            for (int i = 0; i < row1.Length; i++) Add("Key" + row1[i], 0x10 + i);
            Add("BracketLeft", 0x1A); Add("BracketRight", 0x1B); Add("Enter", 0x1C); Add("ControlLeft", 0x1D);
            string row2 = "ASDFGHJKL";
            for (int i = 0; i < row2.Length; i++) Add("Key" + row2[i], 0x1E + i);
            Add("Semicolon", 0x27); Add("Quote", 0x28); Add("Backquote", 0x29); Add("ShiftLeft", 0x2A); Add("Backslash", 0x2B);
            string row3 = "ZXCVBNM";
            for (int i = 0; i < row3.Length; i++) Add("Key" + row3[i], 0x2C + i);
            Add("Comma", 0x33); Add("Period", 0x34); Add("Slash", 0x35); Add("ShiftRight", 0x36);
            Add("NumpadMultiply", 0x37); Add("AltLeft", 0x38); Add("Space", 0x39); Add("CapsLock", 0x3A);
            for (int i = 0; i < 10; i++) Add("F" + (i + 1), 0x3B + i);
            Add("Pause", 0x45); Add("ScrollLock", 0x46);
            Add("Numpad7", 0x47); Add("Numpad8", 0x48); Add("Numpad9", 0x49); Add("NumpadSubtract", 0x4A);
            Add("Numpad4", 0x4B); Add("Numpad5", 0x4C); Add("Numpad6", 0x4D); Add("NumpadAdd", 0x4E);
            Add("Numpad1", 0x4F); Add("Numpad2", 0x50); Add("Numpad3", 0x51); Add("Numpad0", 0x52); Add("NumpadDecimal", 0x53);
            Add("IntlBackslash", 0x56); Add("F11", 0x57); Add("F12", 0x58); Add("NumpadEqual", 0x59);
            int[] f13 = { 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x76 };
            for (int i = 0; i < f13.Length; i++) Add("F" + (13 + i), f13[i]);
            Add("KanaMode", 0x70); Add("IntlRo", 0x73); Add("Convert", 0x79); Add("NonConvert", 0x7B);
            Add("IntlYen", 0x7D); Add("NumpadComma", 0x7E);
            // extended keys
            Add("MediaTrackPrevious", 0xE010); Add("MediaTrackNext", 0xE019); Add("NumpadEnter", 0xE01C);
            Add("ControlRight", 0xE01D); Add("AudioVolumeMute", 0xE020); Add("MediaPlayPause", 0xE022);
            Add("MediaStop", 0xE024); Add("AudioVolumeDown", 0xE02E); Add("AudioVolumeUp", 0xE030);
            Add("NumpadDivide", 0xE035); Add("PrintScreen", 0xE037); Add("AltRight", 0xE038); Add("NumLock", 0xE045);
            Add("Home", 0xE047); Add("ArrowUp", 0xE048); Add("PageUp", 0xE049); Add("ArrowLeft", 0xE04B);
            Add("ArrowRight", 0xE04D); Add("End", 0xE04F); Add("ArrowDown", 0xE050); Add("PageDown", 0xE051);
            Add("Insert", 0xE052); Add("Delete", 0xE053); Add("MetaLeft", 0xE05B); Add("MetaRight", 0xE05C);
            Add("ContextMenu", 0xE05D);
        }

        // DOM code → scan (0xE0xx extended), or -1.
        public static int Scan(string code)
        {
            int s;
            return code != null && ToScan.TryGetValue(code, out s) ? s : -1;
        }

        // Hook data → DOM code, or null. Scan codes above 0xFF are synthetic (AltGr's fake Ctrl).
        public static string Code(uint vk, uint scan, bool extended)
        {
            if (scan == 0) scan = Native.MapVirtualKey(vk, 4) & 0xFF; // MAPVK_VK_TO_VSC_EX
            if (scan == 0 || scan > 0xFF) return null;
            int key = (int)scan | (extended ? 0xE000 : 0);
            string c;
            return ToCode.TryGetValue(key, out c) ? c : null;
        }
    }
}
