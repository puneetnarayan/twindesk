// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The crossing animation: where the pointer leaves
// or arrives, a soft accent glow along the crossing edge (~360 px at 100 %, fades in 0.14 s, out by
// 0.7 s) and a ring at the pointer that closes in when leaving (0.4 s) and spreads out when
// arriving (0.55 s). One click-through, top-most, per-pixel-alpha window around the spot, excluded
// from screen capture (so Monitor 2 / the PC stream never show it). Skipped when Windows' "Animation
// effects" are off.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace MacShare
{
    class Flash : Form
    {
        [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT dst, ref SIZE size, IntPtr hdcSrc, ref POINT src, int key, ref BLEND blend, int flags);
        [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint winIni);
        [DllImport("dwmapi.dll")] static extern int DwmGetColorizationColor(out uint color, out bool opaque);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; public POINT(int x, int y) { this.x = x; this.y = y; } }
        [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; public SIZE(int cx, int cy) { this.cx = cx; this.cy = cy; } }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLEND { public byte op, flags, alpha, format; }

        readonly Timer timer = new Timer();
        DateTime start;
        bool leaving;
        string side;
        Point at;          // the pointer, in physical px
        Rectangle area;    // the window, in physical px
        double scale = 1;
        Color accent = Color.FromArgb(0, 120, 215);
        Bitmap glow;       // the edge glow at full strength, made once per crossing
        Rectangle glowAt;

        public Flash()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            timer.Interval = 15;
            timer.Tick += delegate { Frame(); };
            CreateHandle(); // created up front, so the first crossing animates too
            try { SetWindowDisplayAffinity(Handle, 0x11); } catch (Exception) { } // WDA_EXCLUDEFROMCAPTURE (Win10 2004+)
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x08000000 | 0x8; // LAYERED | TRANSPARENT | TOOLWINDOW | NOACTIVATE | TOPMOST
                return cp;
            }
        }

        static bool Animations()
        {
            bool on;
            return !SystemParametersInfo(0x1042 /* SPI_GETCLIENTAREAANIMATION */, 0, out on, 0) || on;
        }

        // side: the crossing edge ("left", "right", "top", "bottom") or null (hotkey: ring only).
        public void Play(Point p, string side, bool leaving)
        {
            if (!Animations()) return;
            uint c; bool opaque;
            if (DwmGetColorizationColor(out c, out opaque) == 0) accent = Color.FromArgb((int)((c >> 16) & 0xFF), (int)((c >> 8) & 0xFF), (int)(c & 0xFF));
            scale = Screens.Scale(p.X, p.Y);
            at = p;
            this.side = side;
            this.leaving = leaving;
            int half = (int)(200 * scale);
            Rectangle mon = Screen.FromPoint(p).Bounds;
            area = Rectangle.Intersect(new Rectangle(p.X - half, p.Y - half, half * 2, half * 2), mon);
            MakeGlow(at.X - area.X, at.Y - area.Y);
            start = DateTime.UtcNow;
            if (!Visible) Show();
            Frame();
            timer.Start();
        }

        void Frame()
        {
            double t = (DateTime.UtcNow - start).TotalSeconds;
            if (t > 0.72 || area.Width <= 0 || area.Height <= 0) { timer.Stop(); Hide(); return; }
            using (Bitmap b = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppPArgb))
            {
                using (Graphics g = Graphics.FromImage(b))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    float px = at.X - area.X, py = at.Y - area.Y;
                    if (side != null) Glow(g, t, px, py);
                    Ring(g, t, px, py);
                }
                Push(b);
            }
        }

        // Fades in over 0.14 s, holds, out by 0.7 s (the picture is made once per crossing).
        void Glow(Graphics g, double t, float px, float py)
        {
            double a = t < 0.14 ? t / 0.14 : t < 0.35 ? 1 : Math.Max(0, 1 - (t - 0.35) / 0.35);
            if (a <= 0 || glow == null) return;
            using (ImageAttributes ia = new ImageAttributes())
            {
                ColorMatrix cm = new ColorMatrix();
                cm.Matrix33 = (float)a;
                ia.SetColorMatrix(cm);
                g.DrawImage(glow, glowAt, 0, 0, glow.Width, glow.Height, GraphicsUnit.Pixel, ia);
            }
        }

        // Across the edge: strong at the edge, nothing inward. Along it: a soft bell, ±180 px.
        void MakeGlow(float px, float py)
        {
            if (glow != null) { glow.Dispose(); glow = null; }
            if (side == null) return;
            int len = (int)(180 * scale), thick = (int)(26 * scale);
            bool vertical = side == "left" || side == "right";
            int w = vertical ? thick : len * 2, h = vertical ? len * 2 : thick;
            int x0 = side == "left" ? 0 : side == "right" ? area.Width - thick : (int)px - len;
            int y0 = side == "top" ? 0 : side == "bottom" ? area.Height - thick : (int)py - len;
            glowAt = new Rectangle(x0, y0, w, h);
            glow = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            BitmapData d = glow.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int[] px32 = new int[w * h];
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                {
                    double across = vertical ? (side == "left" ? x : w - 1 - x) / (double)thick : (side == "top" ? y : h - 1 - y) / (double)thick;
                    double along = vertical ? (y - h / 2.0) / len : (x - w / 2.0) / len;
                    double v = 0.85 * Math.Pow(1 - Math.Min(1, across), 2) * Math.Max(0, 1 - along * along);
                    px32[y * w + x] = ((int)(v * 255) << 24) | (accent.R << 16) | (accent.G << 8) | accent.B;
                }
            Marshal.Copy(px32, 0, d.Scan0, px32.Length);
            glow.UnlockBits(d);
        }

        // Leaving: closes in from 44 to 6 px in 0.4 s. Arriving: spreads from 6 to 56 px in 0.55 s.
        void Ring(Graphics g, double t, float px, float py)
        {
            double d = leaving ? 0.4 : 0.55;
            if (t > d) return;
            double k = t / d, e = 1 - Math.Pow(1 - k, 3); // ease out
            double r = (leaving ? 44 - 38 * e : 6 + 50 * e) * scale;
            int alpha = (int)(230 * (leaving ? 0.35 + 0.65 * (1 - k * k) : 1 - k));
            using (Pen pen = new Pen(Color.FromArgb(Math.Max(0, Math.Min(255, alpha)), accent), (float)(3 * scale)))
                g.DrawEllipse(pen, (float)(px - r), (float)(py - r), (float)(r * 2), (float)(r * 2));
        }

        void Push(Bitmap b)
        {
            IntPtr hbmp = b.GetHbitmap(Color.FromArgb(0));
            IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
            IntPtr old = SelectObject(dc, hbmp);
            try
            {
                POINT dst = new POINT(area.X, area.Y), src = new POINT(0, 0);
                SIZE size = new SIZE(area.Width, area.Height);
                BLEND bl = new BLEND();
                bl.op = 0; bl.alpha = 255; bl.format = 1; // AC_SRC_OVER, AC_SRC_ALPHA
                UpdateLayeredWindow(Handle, IntPtr.Zero, ref dst, ref size, dc, ref src, 0, ref bl, 2 /* ULW_ALPHA */);
            }
            finally
            {
                SelectObject(dc, old);
                DeleteObject(hbmp);
                DeleteDC(dc);
            }
        }
    }
}
