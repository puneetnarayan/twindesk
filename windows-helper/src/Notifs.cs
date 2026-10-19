// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// This PC's notifications, read from the
// notification database %LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db (SQLite,
// readable by the user) through winsqlite3.dll, which ships with Windows 10+. Polled once a second
// while main asks for it; each new toast becomes an event {"event":"notif", id, app, appName,
// title, subtitle, body, at}. (UserNotificationListener would need package identity.)
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Xml;

namespace MacShare
{
    static class Notifs
    {
        [DllImport("winsqlite3.dll")] static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
        [DllImport("winsqlite3.dll")] static extern int sqlite3_close_v2(IntPtr db);
        [DllImport("winsqlite3.dll")] static extern int sqlite3_busy_timeout(IntPtr db, int ms);
        [DllImport("winsqlite3.dll", CharSet = CharSet.Unicode)] static extern int sqlite3_prepare16_v2(IntPtr db, string sql, int bytes, out IntPtr stmt, IntPtr tail);
        [DllImport("winsqlite3.dll")] static extern int sqlite3_bind_int64(IntPtr stmt, int index, long value);
        [DllImport("winsqlite3.dll")] static extern int sqlite3_step(IntPtr stmt);
        [DllImport("winsqlite3.dll")] static extern int sqlite3_finalize(IntPtr stmt);
        [DllImport("winsqlite3.dll")] static extern long sqlite3_column_int64(IntPtr stmt, int col);
        [DllImport("winsqlite3.dll")] static extern IntPtr sqlite3_column_text16(IntPtr stmt, int col);
        [DllImport("winsqlite3.dll")] static extern IntPtr sqlite3_column_blob(IntPtr stmt, int col);
        [DllImport("winsqlite3.dll")] static extern int sqlite3_column_bytes(IntPtr stmt, int col);

        const int SQLITE_OPEN_READONLY = 1, SQLITE_ROW = 100;
        const string QUERY = "SELECT n.Id, h.PrimaryId, n.Payload, n.ArrivalTime FROM Notification n " +
            "JOIN NotificationHandler h ON h.RecordId = n.HandlerId WHERE n.Id > ? AND n.Type = 'toast' ORDER BY n.Id LIMIT 50";

        public static Action<Dictionary<string, object>> Emit;
        static readonly object gate = new object();
        static Thread worker;
        static volatile bool on;
        static HashSet<string> self = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static Dictionary<string, string> names; // AUMID → display name (shell:AppsFolder)
        static DateTime namesAt = DateTime.MinValue;

        static string DbPath
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Windows\Notifications\wpndatabase.db"); }
        }

        // notifWatch {on, self: [AUMIDs never forwarded]}: returns whether the database can be read.
        public static bool Watch(bool want, List<string> selfIds)
        {
            lock (gate)
            {
                self = new HashSet<string>(selfIds, StringComparer.OrdinalIgnoreCase);
                bool readable = MaxId() >= 0;
                on = want && readable;
                if (on && worker == null)
                {
                    worker = new Thread(Loop);
                    worker.IsBackground = true;
                    worker.SetApartmentState(ApartmentState.STA); // Shell.Application for app names
                    worker.Start();
                }
                return readable;
            }
        }

        static IntPtr Open()
        {
            IntPtr db;
            if (!File.Exists(DbPath)) return IntPtr.Zero;
            if (sqlite3_open_v2(Encoding.UTF8.GetBytes(DbPath + "\0"), out db, SQLITE_OPEN_READONLY, IntPtr.Zero) != 0)
            {
                if (db != IntPtr.Zero) sqlite3_close_v2(db);
                return IntPtr.Zero;
            }
            sqlite3_busy_timeout(db, 500);
            return db;
        }

        // The newest notification's Id, or -1 when the database can't be read.
        static long MaxId()
        {
            IntPtr db = Open();
            if (db == IntPtr.Zero) return -1;
            try
            {
                IntPtr st;
                if (sqlite3_prepare16_v2(db, "SELECT IFNULL(MAX(Id), 0) FROM Notification", -1, out st, IntPtr.Zero) != 0) return -1;
                try { return sqlite3_step(st) == SQLITE_ROW ? sqlite3_column_int64(st, 0) : -1; }
                finally { sqlite3_finalize(st); }
            }
            finally { sqlite3_close_v2(db); }
        }

        static void Loop()
        {
            long last = MaxId(); // only what arrives from now on
            while (true)
            {
                Thread.Sleep(1000);
                if (!on) { last = -1; continue; }
                if (last < 0) { last = MaxId(); continue; }
                try { last = Poll(last); }
                catch (Exception e) { Console.Error.WriteLine("notifs: " + e.Message); }
            }
        }

        static long Poll(long last)
        {
            IntPtr db = Open();
            if (db == IntPtr.Zero) return last;
            List<Dictionary<string, object>> found = new List<Dictionary<string, object>>();
            try
            {
                IntPtr st;
                if (sqlite3_prepare16_v2(db, QUERY, -1, out st, IntPtr.Zero) != 0) return last;
                try
                {
                    sqlite3_bind_int64(st, 1, last);
                    while (sqlite3_step(st) == SQLITE_ROW)
                    {
                        last = Math.Max(last, sqlite3_column_int64(st, 0));
                        string app = Marshal.PtrToStringUni(sqlite3_column_text16(st, 1)) ?? "";
                        if (app.Length == 0 || self.Contains(app)) continue;
                        int n = sqlite3_column_bytes(st, 2);
                        byte[] payload = new byte[n];
                        if (n > 0) Marshal.Copy(sqlite3_column_blob(st, 2), payload, 0, n);
                        long arrival = sqlite3_column_int64(st, 3);
                        Dictionary<string, object> e = Parse(Encoding.UTF8.GetString(payload));
                        if (e == null) continue;
                        e["event"] = "notif";
                        e["id"] = Convert.ToString(last);
                        e["app"] = app;
                        e["at"] = arrival > 0 ? (DateTime.FromFileTimeUtc(arrival) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds : 0;
                        found.Add(e);
                    }
                }
                finally { sqlite3_finalize(st); }
            }
            finally { sqlite3_close_v2(db); }
            foreach (Dictionary<string, object> e in found)
            {
                e["appName"] = AppName((string)e["app"]);
                Emit(e);
            }
            return last;
        }

        // Toast XML: the first <text> of the first binding is the title, the rest the body.
        static Dictionary<string, object> Parse(string xml)
        {
            XmlDocument doc = new XmlDocument();
            try { doc.LoadXml(xml.TrimEnd('\0')); }
            catch (Exception) { return null; }
            XmlNode binding = doc.SelectSingleNode("//binding");
            if (binding == null) return null;
            List<string> texts = new List<string>();
            foreach (XmlNode t in binding.SelectNodes("text"))
            {
                XmlAttribute place = t.Attributes == null ? null : t.Attributes["placement"];
                if (place != null && place.Value == "attribution") continue;
                string v = t.InnerText.Trim();
                if (v.Length > 0) texts.Add(v);
            }
            if (texts.Count == 0) return null;
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["title"] = Cut(texts[0]);
            d["subtitle"] = "";
            d["body"] = Cut(string.Join("\n", texts.GetRange(1, texts.Count - 1).ToArray()));
            return d;
        }

        static string Cut(string s)
        {
            return s.Length > 500 ? s.Substring(0, 500) : s;
        }

        // Display name of an app by AUMID, from the Start menu's apps (shell:AppsFolder); reloaded
        // at most once a minute when an unknown one shows up.
        static string AppName(string aumid)
        {
            string name;
            if (names != null && names.TryGetValue(aumid, out name)) return name;
            if (names == null || (DateTime.UtcNow - namesAt).TotalSeconds > 60)
            {
                namesAt = DateTime.UtcNow;
                Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                try
                {
                    object shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application"));
                    object folder = Invoke(shell, "NameSpace", BindingFlags.InvokeMethod, "shell:AppsFolder");
                    object items = Invoke(folder, "Items", BindingFlags.InvokeMethod);
                    int count = Convert.ToInt32(Invoke(items, "Count", BindingFlags.GetProperty));
                    for (int i = 0; i < count; i++)
                    {
                        object it = Invoke(items, "Item", BindingFlags.InvokeMethod, i);
                        string id = Invoke(it, "Path", BindingFlags.GetProperty) as string;
                        string n = Invoke(it, "Name", BindingFlags.GetProperty) as string;
                        if (!string.IsNullOrEmpty(id) && !string.IsNullOrEmpty(n)) map[id] = n;
                    }
                }
                catch (Exception) { /* keep what we had */ }
                if (map.Count > 0 || names == null) names = map;
                if (names.TryGetValue(aumid, out name)) return name;
            }
            // Unknown: "Microsoft.Windows.Explorer" → "Explorer", "C:\…\app.exe" → "app".
            string last = aumid.Substring(Math.Max(aumid.LastIndexOf('!'), Math.Max(aumid.LastIndexOf('\\'), aumid.LastIndexOf('.') >= 0 && !aumid.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? aumid.LastIndexOf('.') : -1)) + 1);
            if (last.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) last = last.Substring(0, last.Length - 4);
            return last.Length > 0 ? last : aumid;
        }

        static object Invoke(object o, string name, BindingFlags how, params object[] args)
        {
            return o == null ? null : o.GetType().InvokeMember(name, how, null, o, args);
        }
    }
}
