// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This PC's precision touchpad while we drive the other
// computer. Raw Input from HID usage page 0x0D / usage 0x05 (the touchpad collection) gives the
// contacts; the HID parser (hid.dll HidP_*) reads tip switch, contact id, X and Y per finger. Frames
// go to a small recogniser: pinch → `zoom` (begin / change / end, v = magnification step), three
// fingers up / down / sideways → `overview` / `desktop` / `overview`, four fingers left / right →
// `spaceRight` / `spaceLeft` (as Windows: fingers left, the desktop on the right), a quick three-finger tap → `launcher`. Capture.cs sends them as k.ge
// and uses Pinching / Fingers to swallow the Ctrl+wheel Windows makes from a pinch.
// Windows' own three- and four-finger shell gestures can't be stopped from user mode: while
// capturing they may also act on this PC.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace MacShare
{
    class Touchpad
    {
        // ---- hid.dll / user32 ----
        const uint RIDI_PREPARSEDDATA = 0x20000005;
        const int HIDP_STATUS_SUCCESS = 0x00110000;
        const ushort PAGE_GENERIC = 0x01, PAGE_DIGITIZER = 0x0D;
        const ushort USAGE_X = 0x30, USAGE_Y = 0x31, USAGE_TIP = 0x42, USAGE_CONTACT_ID = 0x51, USAGE_CONTACT_COUNT = 0x54;

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint GetRawInputDeviceInfo(IntPtr hDevice, uint command, IntPtr data, ref uint size);

        [StructLayout(LayoutKind.Sequential)]
        struct HIDP_CAPS
        {
            public ushort Usage, UsagePage, InputReportByteLength, OutputReportByteLength, FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes, NumberInputButtonCaps, NumberInputValueCaps, NumberInputDataIndices,
                NumberOutputButtonCaps, NumberOutputValueCaps, NumberOutputDataIndices,
                NumberFeatureButtonCaps, NumberFeatureValueCaps, NumberFeatureDataIndices;
        }

        // HIDP_VALUE_CAPS (72 bytes); the union's first field is Usage (or UsageMin for a range).
        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        struct HIDP_VALUE_CAPS
        {
            public ushort UsagePage; public byte ReportID, IsAlias; public ushort BitField, LinkCollection, LinkUsage, LinkUsagePage;
            public byte IsRange, IsStringRange, IsDesignatorRange, IsAbsolute, HasNull, Reserved;
            public ushort BitSize, ReportCount;
            public ushort R0, R1, R2, R3, R4;
            public uint UnitsExp, Units;
            public int LogicalMin, LogicalMax, PhysicalMin, PhysicalMax;
            public ushort Usage, U1, U2, U3, U4, U5, U6, U7;
        }

        [DllImport("hid.dll")] static extern int HidP_GetCaps(IntPtr preparsed, out HIDP_CAPS caps);
        [DllImport("hid.dll")] static extern int HidP_GetValueCaps(int reportType, [Out] HIDP_VALUE_CAPS[] caps, ref ushort length, IntPtr preparsed);
        [DllImport("hid.dll")] static extern int HidP_GetUsageValue(int reportType, ushort usagePage, ushort linkCollection, ushort usage, out uint value, IntPtr preparsed, byte[] report, uint reportLength);
        [DllImport("hid.dll")] static extern int HidP_GetUsages(int reportType, ushort usagePage, ushort linkCollection, [Out] ushort[] usages, ref uint length, IntPtr preparsed, byte[] report, uint reportLength);

        // One touchpad: its parser data, the link collection of every finger slot, the axes' range.
        class Dev
        {
            public IntPtr Pre;
            public readonly List<ushort> Fingers = new List<ushort>();
            public ushort CountLink;
            public bool HasCount;
            public double MaxX = 1, MaxY = 1;
            public readonly List<Contact> Pending = new List<Contact>(); // hybrid reports: one or a few fingers each
            public int Expect, Got;
        }

        struct Contact { public int Id; public double X, Y; }

        readonly Dictionary<IntPtr, Dev> devs = new Dictionary<IntPtr, Dev>();
        readonly Action<string, string, double> emit; // (g, phase, v)

        public Touchpad(Action<string, string, double> emit)
        {
            this.emit = emit;
        }

        // ---- reading ----

        Dev Open(IntPtr h)
        {
            Dev d;
            if (devs.TryGetValue(h, out d)) return d;
            d = null;
            uint size = 0;
            GetRawInputDeviceInfo(h, RIDI_PREPARSEDDATA, IntPtr.Zero, ref size);
            if (size > 0 && size < 1 << 20)
            {
                IntPtr pre = Marshal.AllocHGlobal((int)size);
                HIDP_CAPS caps;
                if (GetRawInputDeviceInfo(h, RIDI_PREPARSEDDATA, pre, ref size) != uint.MaxValue && HidP_GetCaps(pre, out caps) == HIDP_STATUS_SUCCESS)
                {
                    ushort n = caps.NumberInputValueCaps;
                    HIDP_VALUE_CAPS[] vc = new HIDP_VALUE_CAPS[Math.Max((int)n, 1)];
                    if (n > 0 && HidP_GetValueCaps(0, vc, ref n, pre) == HIDP_STATUS_SUCCESS)
                    {
                        d = new Dev { Pre = pre };
                        for (int i = 0; i < n; i++)
                        {
                            HIDP_VALUE_CAPS c = vc[i];
                            if (c.UsagePage == PAGE_GENERIC && c.Usage == USAGE_X && c.IsRange == 0)
                            {
                                if (!d.Fingers.Contains(c.LinkCollection)) d.Fingers.Add(c.LinkCollection);
                                if (c.LogicalMax > 0) d.MaxX = c.LogicalMax;
                            }
                            else if (c.UsagePage == PAGE_GENERIC && c.Usage == USAGE_Y && c.IsRange == 0 && c.LogicalMax > 0) d.MaxY = c.LogicalMax;
                            else if (c.UsagePage == PAGE_DIGITIZER && c.Usage == USAGE_CONTACT_COUNT) { d.CountLink = c.LinkCollection; d.HasCount = true; }
                        }
                    }
                }
                if (d == null) Marshal.FreeHGlobal(pre);
            }
            devs[h] = d; // null: not a touchpad we can read (asked once)
            return d;
        }

        // WM_INPUT of type HID: header, then RAWHID {dwSizeHid, dwCount, bRawData[size × count]}.
        public void OnRaw(IntPtr buf, int header)
        {
            IntPtr h = Marshal.ReadIntPtr(buf, 8);
            Dev d = Open(h);
            if (d == null || d.Fingers.Count == 0) return;
            int sizeHid = Marshal.ReadInt32(buf, header), count = Marshal.ReadInt32(buf, header + 4);
            if (sizeHid <= 0 || sizeHid > 4096 || count <= 0 || count > 64) return;
            byte[] report = new byte[sizeHid];
            for (int r = 0; r < count; r++)
            {
                Marshal.Copy(IntPtr.Add(buf, header + 8 + r * sizeHid), report, 0, sizeHid);
                Report(d, report);
            }
        }

        // A frame lists every finger on the pad. Parallel mode: all fingers in one report. Hybrid mode:
        // the first report carries the contact count, the next ones carry the rest (count 0).
        void Report(Dev d, byte[] report)
        {
            uint len = (uint)report.Length, v;
            int total = -1;
            if (d.HasCount && HidP_GetUsageValue(0, PAGE_DIGITIZER, d.CountLink, USAGE_CONTACT_COUNT, out v, d.Pre, report, len) == HIDP_STATUS_SUCCESS) total = (int)v;
            if (total > 0 || !d.HasCount) { d.Pending.Clear(); d.Got = 0; d.Expect = total > 0 ? total : d.Fingers.Count; }
            if (d.Expect <= 0) return; // a stray continuation
            ushort[] usages = new ushort[16];
            foreach (ushort link in d.Fingers)
            {
                if (d.Got >= d.Expect) break;
                uint n = (uint)usages.Length, id, x, y;
                bool tip = false;
                if (HidP_GetUsages(0, PAGE_DIGITIZER, link, usages, ref n, d.Pre, report, len) == HIDP_STATUS_SUCCESS)
                    for (int i = 0; i < n; i++) if (usages[i] == USAGE_TIP) tip = true;
                if (HidP_GetUsageValue(0, PAGE_GENERIC, link, USAGE_X, out x, d.Pre, report, len) != HIDP_STATUS_SUCCESS) continue;
                if (HidP_GetUsageValue(0, PAGE_GENERIC, link, USAGE_Y, out y, d.Pre, report, len) != HIDP_STATUS_SUCCESS) continue;
                if (HidP_GetUsageValue(0, PAGE_DIGITIZER, link, USAGE_CONTACT_ID, out id, d.Pre, report, len) != HIDP_STATUS_SUCCESS) id = link;
                d.Got++;
                if (tip) d.Pending.Add(new Contact { Id = (int)id, X = x / d.MaxX, Y = y / d.MaxY });
            }
            if (d.Got >= d.Expect || !d.HasCount)
            {
                Frame(new List<Contact>(d.Pending));
                d.Pending.Clear();
                d.Expect = 0;
            }
        }

        // ---- recognising ----

        public int Fingers;        // fingers on the pad now
        public bool Pinching;      // a pinch is going on (its Ctrl+wheel must not go over)
        int maxFingers;
        DateTime started;
        double sx, sy, travel;     // centroid when the current finger count began, and how far it went
        double startDist, lastDist;
        bool fired;
        DateTime lastZoom;
        double zoomAcc;
        public bool Active;        // Capture: we are capturing and gestures are on

        static void Centroid(List<Contact> c, out double x, out double y)
        {
            x = 0; y = 0;
            foreach (Contact k in c) { x += k.X; y += k.Y; }
            x /= Math.Max(1, c.Count); y /= Math.Max(1, c.Count);
        }

        static double Spread(List<Contact> c)
        {
            if (c.Count < 2) return 0;
            double dx = c[0].X - c[1].X, dy = c[0].Y - c[1].Y;
            return Math.Sqrt(dx * dx + dy * dy);
        }

        void Frame(List<Contact> c)
        {
            int n = c.Count;
            DateTime now = DateTime.UtcNow;
            if (n == 0)
            {
                if (Pinching) { Flush(true); if (Active) emit("zoom", "end", 0); }
                if (Active && !fired && maxFingers == 3 && (now - started).TotalMilliseconds < 300 && travel < 0.03) emit("launcher", null, 0);
                Fingers = 0; maxFingers = 0; Pinching = false; fired = false; travel = 0;
                return;
            }
            double cx, cy;
            Centroid(c, out cx, out cy);
            if (Fingers == 0) started = now;
            if (n > maxFingers || n != Fingers)
            {
                if (n > maxFingers) { maxFingers = n; fired = false; }
                sx = cx; sy = cy;
                if (n == 2) { startDist = lastDist = Spread(c); }
                else if (Pinching) { Flush(true); if (Active) emit("zoom", "end", 0); Pinching = false; }
            }
            Fingers = n;
            double mx = cx - sx, my = cy - sy;
            travel = Math.Max(travel, Math.Sqrt(mx * mx + my * my));

            if (n == 2 && maxFingers == 2)
            {
                double dist = Spread(c);
                if (!Pinching && startDist > 0.01 && Math.Abs(dist / startDist - 1) > 0.12 && Math.Abs(dist - startDist) > travel * 0.8)
                {
                    Pinching = true;
                    zoomAcc = 0;
                    lastDist = dist;
                    if (Active) emit("zoom", "begin", 0);
                }
                else if (Pinching && lastDist > 0.005)
                {
                    zoomAcc += dist / lastDist - 1;
                    lastDist = dist;
                    if ((now - lastZoom).TotalMilliseconds >= 16) Flush(false);
                }
                return;
            }
            if (n >= 3 && n == maxFingers && !fired && travel > 0.12)
            {
                fired = true;
                bool horizontal = Math.Abs(mx) > Math.Abs(my);
                string g;
                if (n == 3) g = horizontal ? "overview" : my < 0 ? "overview" : "desktop";
                else g = horizontal ? (mx < 0 ? "spaceRight" : "spaceLeft") : my < 0 ? "overview" : "desktop"; // 4 down: show desktop (minimize all), as on Windows
                if (Active) emit(g, null, 0);
            }
        }

        void Flush(bool force)
        {
            if (Math.Abs(zoomAcc) < (force ? 1e-4 : 0.005)) return;
            if (Active) emit("zoom", "change", Math.Round(zoomAcc, 4));
            zoomAcc = 0;
            lastZoom = DateTime.UtcNow;
        }
    }
}
