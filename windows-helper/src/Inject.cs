// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Portions adapted from Beamer (https://github.com/kalkman-code/beamer), Copyright (C) Kalkman Code,
// GPL-3.0. Changed: C# port of the SendInput absolute-move and scan-code key approach.
// SendInput injection of k.* events. Every input carries
// dwExtraInfo = MARK so our own capture/edge code skips it. Held keys/buttons are tracked for
// releaseAll.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;

namespace MacShare
{
    class Injector
    {
        readonly HashSet<int> heldScans = new HashSet<int>();
        readonly HashSet<int> heldButtons = new HashSet<int>();
        double fx, fy;              // sub-pixel remainder of relative moves (physical px)
        double wheelRem, hwheelRem; // remainder of wheel units

        // Called after every injected move with the new position and the requested logical delta
        // (the return edge watches pushes through the edge, armReturn).
        public Action<int, int, double, double> Moved;

        static readonly int Size = Marshal.SizeOf(typeof(Native.INPUT));

        static void Send(Native.INPUT input)
        {
            Native.SendInput(1, new Native.INPUT[] { input }, Size);
        }

        static Native.INPUT Mouse(int dx, int dy, uint data, uint flags)
        {
            Native.INPUT i = new Native.INPUT();
            i.type = Native.INPUT_MOUSE;
            i.u.mi.dx = dx;
            i.u.mi.dy = dy;
            i.u.mi.mouseData = data;
            i.u.mi.dwFlags = flags;
            i.u.mi.dwExtraInfo = Native.MARK;
            return i;
        }

        // Absolute move on the virtual desktop (avoids Windows applying pointer acceleration twice).
        public static void MoveTo(int x, int y)
        {
            int left = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN), top = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int w = Math.Max(2, Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN)), h = Math.Max(2, Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
            int ax = (int)Math.Round((x - left) * 65535.0 / (w - 1));
            int ay = (int)Math.Round((y - top) * 65535.0 / (h - 1));
            Send(Mouse(ax, ay, 0, Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK));
        }

        // Relative move in logical px (main already applied `speed`); scaled by the monitor's DPI.
        public void Move(double dx, double dy)
        {
            Native.POINT cur;
            Native.GetCursorPos(out cur);
            double scale = Screens.Scale(cur.x, cur.y);
            double tx = cur.x + fx + dx * scale, ty = cur.y + fy + dy * scale;
            int ix = (int)Math.Round(tx), iy = (int)Math.Round(ty);
            Point p = Screens.Clamp(ix, iy, cur.x, cur.y);
            if (p.X != ix || p.Y != iy) { fx = 0; fy = 0; } // stopped by an edge: drop the remainder
            else { fx = tx - ix; fy = ty - iy; }
            if (p.X != cur.x || p.Y != cur.y) MoveTo(p.X, p.Y);
            if (Moved != null) Moved(p.X, p.Y, dx, dy);
        }

        public void Button(int b, bool down)
        {
            uint flags, data = 0;
            switch (b)
            {
                case 0: flags = down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP; break;
                case 1: flags = down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP; break;
                case 2: flags = down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP; break;
                case 3: flags = down ? Native.MOUSEEVENTF_XDOWN : Native.MOUSEEVENTF_XUP; data = Native.XBUTTON1; break;
                case 4: flags = down ? Native.MOUSEEVENTF_XDOWN : Native.MOUSEEVENTF_XUP; data = Native.XBUTTON2; break;
                default: return;
            }
            if (down) heldButtons.Add(b); else heldButtons.Remove(b);
            Send(Mouse(0, 0, data, flags));
        }

        // DOM sign: positive dy = scroll down (content further down) → negative WHEEL data.
        public void Wheel(double dx, double dy, bool pixel)
        {
            double k = pixel ? 3 : 120;
            wheelRem += -dy * k;
            hwheelRem += dx * k;
            int v = (int)Math.Truncate(wheelRem), h = (int)Math.Truncate(hwheelRem);
            wheelRem -= v;
            hwheelRem -= h;
            if (v != 0) Send(Mouse(0, 0, unchecked((uint)v), Native.MOUSEEVENTF_WHEEL));
            if (h != 0) Send(Mouse(0, 0, unchecked((uint)h), Native.MOUSEEVENTF_HWHEEL));
        }

        public void Key(string code, bool down)
        {
            int scan = Keys.Scan(code);
            if (scan < 0) return;
            if (down) heldScans.Add(scan); else heldScans.Remove(scan);
            SendScan(scan, down);
        }

        static void SendScan(int scan, bool down)
        {
            Native.INPUT i = new Native.INPUT();
            i.type = Native.INPUT_KEYBOARD;
            i.u.ki.wScan = (ushort)(scan & 0xFF);
            i.u.ki.dwFlags = Native.KEYEVENTF_SCANCODE | ((scan & 0xE000) != 0 ? Native.KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : Native.KEYEVENTF_KEYUP);
            i.u.ki.dwExtraInfo = Native.MARK;
            Send(i);
        }

        // Esc down+up (cancels a local drag-and-drop loop).
        public static void Escape()
        {
            SendScan(0x01, true);
            SendScan(0x01, false);
        }

        public void ReleaseAll()
        {
            foreach (int s in new List<int>(heldScans)) SendScan(s, false);
            heldScans.Clear();
            foreach (int b in new List<int>(heldButtons)) Button(b, false);
            heldButtons.Clear();
            wheelRem = hwheelRem = 0;
        }

        // A k.* event from the owner.
        public void Apply(Dictionary<string, object> ev)
        {
            switch (Json.Str(ev, "t", ""))
            {
                case "k.mm": Move(Json.Num(ev, "dx", 0), Json.Num(ev, "dy", 0)); break;
                case "k.md": Button((int)Json.Num(ev, "b", -1), true); break;
                case "k.mu": Button((int)Json.Num(ev, "b", -1), false); break;
                case "k.wh": Wheel(Json.Num(ev, "dx", 0), Json.Num(ev, "dy", 0), Json.Str(ev, "mode", "line") == "pixel"); break;
                case "k.kd": Key(Json.Str(ev, "code", null), true); break;
                case "k.ku": Key(Json.Str(ev, "code", null), false); break;
            }
        }
    }
}
