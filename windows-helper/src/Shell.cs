// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Where is the pointer, file-wise? The folder of the Explorer window under it, or the Desktop
// (the receiver places files there).
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

namespace MacShare
{
    static class Shell
    {
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Native.POINT p);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);

        // path = an existing folder, or null; desktop = the pointer is on the desktop.
        public static void FolderAt(out string path, out bool desktop)
        {
            path = null;
            desktop = false;
            Native.POINT p;
            Native.GetCursorPos(out p);
            IntPtr root = GetAncestor(WindowFromPoint(p), 2); // GA_ROOT
            StringBuilder cls = new StringBuilder(64);
            GetClassName(root, cls, cls.Capacity);
            string c = cls.ToString();
            if (c == "Progman" || c == "WorkerW")
            {
                desktop = true;
                path = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                return;
            }
            if (c != "CabinetWClass" && c != "ExploreWClass") return;
            try
            {
                Type t = Type.GetTypeFromProgID("Shell.Application");
                object shell = Activator.CreateInstance(t);
                object windows = Call(shell, "Windows");
                int count = Convert.ToInt32(Get(windows, "Count"));
                for (int i = 0; i < count; i++)
                {
                    object w = Call(windows, "Item", i);
                    if (w == null) continue;
                    long h;
                    try { h = Convert.ToInt64(Get(w, "HWND")); } catch (Exception) { continue; }
                    if (h != root.ToInt64()) continue;
                    // Windows 11 tabs share one HWND; the first tab found wins.
                    string fp = Get(Get(Get(Get(w, "Document"), "Folder"), "Self"), "Path") as string;
                    if (fp != null && Directory.Exists(fp)) { path = fp; return; }
                }
            }
            catch (Exception) { /* no folder: the caller falls back to Downloads */ }
        }

        // ---- copy and paste files with shortcuts ----

        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

        // The window in front, if it is Explorer or the desktop: its shell view (Document), else null.
        static object FrontView(out bool desktop)
        {
            desktop = false;
            IntPtr root = GetAncestor(GetForegroundWindow(), 2); // GA_ROOT
            StringBuilder cls = new StringBuilder(64);
            GetClassName(root, cls, cls.Capacity);
            string c = cls.ToString();
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
            object windows = Call(shell, "Windows");
            if (c == "Progman" || c == "WorkerW")
            {
                desktop = true;
                return DesktopView(windows);
            }
            if (c != "CabinetWClass" && c != "ExploreWClass") return null;
            int count = Convert.ToInt32(Get(windows, "Count"));
            for (int i = 0; i < count; i++)
            {
                object w = Call(windows, "Item", i);
                if (w == null) continue;
                long h;
                try { h = Convert.ToInt64(Get(w, "HWND")); } catch (Exception) { continue; }
                if (h == root.ToInt64()) return Get(w, "Document"); // Windows 11 tabs: the first one
            }
            return null;
        }

        // The desktop's own view: IShellWindows.FindWindowSW(CSIDL_DESKTOP, SWC_DESKTOP, SWFO_NEEDDISPATCH).
        static object DesktopView(object windows)
        {
            try
            {
                object[] args = new object[] { 0, null, 8, 0, 1 }; // pvarloc = CSIDL_DESKTOP, swClass = SWC_DESKTOP, phwnd, SWFO_NEEDDISPATCH
                ParameterModifier mod = new ParameterModifier(5);
                mod[3] = true; // phwnd is out
                object w = windows.GetType().InvokeMember("FindWindowSW", BindingFlags.InvokeMethod, null, windows, args, new ParameterModifier[] { mod }, null, null);
                return Get(w, "Document");
            }
            catch (Exception) { return null; }
        }

        // The files selected in the Explorer window (or on the desktop) in front; frontExplorer =
        // one of those is in front at all.
        public static List<string> FrontSelection(out bool frontExplorer)
        {
            List<string> paths = new List<string>();
            bool desktop;
            object doc = FrontView(out desktop);
            frontExplorer = doc != null;
            if (doc == null) return paths;
            object items = Call(doc, "SelectedItems");
            int count = Convert.ToInt32(Get(items, "Count"));
            for (int i = 0; i < count && i < 1000; i++)
            {
                string p = Get(Call(items, "Item", i), "Path") as string;
                if (p != null && (File.Exists(p) || Directory.Exists(p))) paths.Add(p);
            }
            return paths;
        }

        // The folder of the Explorer window in front, or null (the caller uses the Desktop).
        public static string FrontFolder()
        {
            bool desktop;
            object doc = FrontView(out desktop);
            if (desktop) return Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string p = doc == null ? null : Get(Get(Get(doc, "Folder"), "Self"), "Path") as string;
            return p != null && Directory.Exists(p) ? p : null;
        }

        // Select the pasted items in the Explorer window showing `dir` (or the desktop), if any.
        public static void SelectIn(string dir, List<string> names)
        {
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
            object windows = Call(shell, "Windows");
            object doc = null;
            string desk = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (SamePath(dir, desk)) doc = DesktopView(windows);
            else
            {
                int count = Convert.ToInt32(Get(windows, "Count"));
                for (int i = 0; i < count && doc == null; i++)
                {
                    object w = Call(windows, "Item", i);
                    object d = null;
                    try { d = Get(w, "Document"); } catch (Exception) { continue; }
                    string p = null;
                    try { p = Get(Get(Get(d, "Folder"), "Self"), "Path") as string; } catch (Exception) { }
                    if (p != null && SamePath(p, dir)) doc = d;
                }
            }
            if (doc == null) return;
            object folder = Get(doc, "Folder");
            bool first = true;
            foreach (string n in names)
            {
                object item = null;
                try { item = Call(folder, "ParseName", n); } catch (Exception) { }
                if (item == null) continue;
                // SVSI_SELECT 1, DESELECTOTHERS 4, ENSUREVISIBLE 8, FOCUSED 16
                Call(doc, "SelectItem", item, first ? 1 | 4 | 8 | 16 : 1);
                first = false;
            }
        }

        static bool SamePath(string a, string b)
        {
            return string.Equals(a.TrimEnd(Path.DirectorySeparatorChar), b.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase);
        }

        static object Get(object o, string name)
        {
            return o == null ? null : o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, null);
        }

        static object Call(object o, string name, params object[] args)
        {
            return o == null ? null : o.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, o, args);
        }
    }
}
