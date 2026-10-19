// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// The picture under the pointer while a drag from the Mac is on this PC: the shell icon of the
// first item (a folder or the file type, 48 px, others stacked behind it), its name or "N items",
// handed to the shell's drag-image helper (which also shows the target's "Copy to …" text).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using ComIDataObject = System.Runtime.InteropServices.ComTypes.IDataObject;

namespace MacShare
{
    static class DragImage
    {
        [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct SHDRAGIMAGE { public SIZE size; public POINT offset; public IntPtr hbmp; public int colorKey; }

        [ComImport, Guid("83E07D0D-0C5F-4163-BF1A-60B274051E40"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IDragSourceHelper2
        {
            [PreserveSig] int InitializeFromBitmap(ref SHDRAGIMAGE image, ComIDataObject data);
            [PreserveSig] int InitializeFromWindow(IntPtr hwnd, ref POINT pt, ComIDataObject data);
            [PreserveSig] int SetFlags(int flags);
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SHFILEINFO { public IntPtr hIcon; public int iIcon; public uint attrs; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string type; }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SHGetFileInfo(string path, uint attrs, ref SHFILEINFO info, uint size, uint flags);
        [DllImport("shell32.dll", EntryPoint = "#727")] static extern int SHGetImageList(int list, ref Guid iid, out IntPtr himl);
        [DllImport("comctl32.dll")] static extern IntPtr ImageList_GetIcon(IntPtr himl, int i, uint flags);
        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
        [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
        [StructLayout(LayoutKind.Sequential)]
        struct BITMAPINFOHEADER { public int size, width, height; public short planes, bitCount; public int compression, sizeImage, xppm, yppm, clrUsed, clrImportant; }

        const int W = 160, H = 96, ICON = 48;

        // Icon of a name that doesn't exist here yet: by its type (folder or extension).
        static Bitmap Icon(string name, bool dir)
        {
            SHFILEINFO fi = new SHFILEINFO();
            const uint SHGFI_SYSICONINDEX = 0x4000, SHGFI_USEFILEATTRIBUTES = 0x10;
            SHGetFileInfo(dir ? "folder" : name, dir ? 0x10u : 0x80u, ref fi, (uint)Marshal.SizeOf(fi), SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES);
            Guid iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"); // IImageList
            IntPtr himl;
            if (SHGetImageList(2 /* SHIL_EXTRALARGE, 48 px */, ref iid, out himl) != 0) return null;
            IntPtr hicon = ImageList_GetIcon(himl, fi.iIcon, 1 /* ILD_TRANSPARENT */);
            if (hicon == IntPtr.Zero) return null;
            try { using (Icon ic = System.Drawing.Icon.FromHandle(hicon)) return ic.ToBitmap(); }
            finally { DestroyIcon(hicon); }
        }

        // names: the top-level items' names (with "/" at the end for folders).
        public static void Attach(ComIDataObject data, List<DragEntry> entries, List<string> names)
        {
            try
            {
                using (Bitmap img = Draw(names))
                {
                    SHDRAGIMAGE di = new SHDRAGIMAGE();
                    di.size.cx = W; di.size.cy = H;
                    di.offset.x = W / 2; di.offset.y = ICON / 2 + 6;
                    di.hbmp = Dib(img);
                    di.colorKey = unchecked((int)0xFFFFFFFF);
                    Type t = Type.GetTypeFromCLSID(new Guid("4657278A-411B-11d2-839A-00C04FD918D0")); // CLSID_DragDropHelper
                    IDragSourceHelper2 helper = (IDragSourceHelper2)Activator.CreateInstance(t);
                    helper.SetFlags(1); // DSH_ALLOWDROPDESCRIPTIONTEXT: "Copy to Desktop"
                    helper.InitializeFromBitmap(ref di, data); // the shell owns the bitmap now
                }
            }
            catch (Exception) { /* no picture: the plain drag cursor */ }
        }

        static Bitmap Draw(List<string> names)
        {
            Bitmap b = new Bitmap(W, H, PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(b))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                int shown = Math.Min(3, names.Count);
                for (int i = shown - 1; i >= 0; i--) // stacked: the first item in front
                {
                    string n = names[i];
                    bool dir = n.EndsWith("/");
                    Bitmap ic = Icon(dir ? n.TrimEnd('/') : n, dir);
                    if (ic == null) continue;
                    using (ic) g.DrawImage(ic, (W - ICON) / 2 + i * 7, 2 + i * 4, ICON, ICON);
                }
                string label = names.Count == 1 ? names[0].TrimEnd('/') : names.Count + " items";
                using (Font f = new Font("Segoe UI", 9f))
                using (StringFormat sf = new StringFormat())
                {
                    sf.Alignment = StringAlignment.Center;
                    sf.Trimming = StringTrimming.EllipsisCharacter;
                    sf.FormatFlags = StringFormatFlags.NoWrap;
                    RectangleF r = new RectangleF(4, ICON + 14, W - 8, 20);
                    SizeF sz = g.MeasureString(label, f, (int)r.Width, sf);
                    RectangleF pill = new RectangleF(W / 2f - sz.Width / 2 - 6, r.Y - 1, sz.Width + 12, sz.Height + 2);
                    using (GraphicsPath p = Round(pill, 6))
                    using (SolidBrush bg = new SolidBrush(Color.FromArgb(200, 0, 103, 192)))
                        g.FillPath(bg, p);
                    g.DrawString(label, f, Brushes.White, r, sf);
                }
                if (names.Count > 1) // count badge, like Explorer
                {
                    RectangleF c = new RectangleF((W + ICON) / 2 + 2, 0, 22, 18);
                    using (GraphicsPath p = Round(c, 9))
                    using (SolidBrush bg = new SolidBrush(Color.FromArgb(255, 0, 103, 192)))
                        g.FillPath(bg, p);
                    using (Font f = new Font("Segoe UI", 8f, FontStyle.Bold))
                    using (StringFormat sf = new StringFormat())
                    {
                        sf.Alignment = StringAlignment.Center;
                        sf.LineAlignment = StringAlignment.Center;
                        g.DrawString(names.Count > 99 ? "99+" : names.Count.ToString(), f, Brushes.White, c, sf);
                    }
                }
            }
            return b;
        }

        static GraphicsPath Round(RectangleF r, float rad)
        {
            GraphicsPath p = new GraphicsPath();
            float d = rad * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        // A top-down 32 bpp premultiplied DIB section (what the shell's drag image expects).
        static IntPtr Dib(Bitmap img)
        {
            BITMAPINFOHEADER h = new BITMAPINFOHEADER();
            h.size = Marshal.SizeOf(h); h.width = img.Width; h.height = -img.Height; h.planes = 1; h.bitCount = 32;
            IntPtr bits;
            IntPtr hbmp = CreateDIBSection(IntPtr.Zero, ref h, 0, out bits, IntPtr.Zero, 0);
            BitmapData d = img.LockBits(new Rectangle(0, 0, img.Width, img.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppPArgb);
            try
            {
                byte[] buf = new byte[d.Stride * img.Height];
                Marshal.Copy(d.Scan0, buf, 0, buf.Length);
                Marshal.Copy(buf, 0, bits, buf.Length);
            }
            finally { img.UnlockBits(d); }
            return hbmp;
        }
    }
}
