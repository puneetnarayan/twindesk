// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Tiny wrapper over JavaScriptSerializer: parse a command line, read typed fields, write a line.
using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace MacShare
{
    static class Json
    {
        static readonly JavaScriptSerializer S = new JavaScriptSerializer();

        public static Dictionary<string, object> Parse(string line)
        {
            return S.Deserialize<Dictionary<string, object>>(line);
        }

        public static string Write(Dictionary<string, object> d)
        {
            return S.Serialize(d);
        }

        public static string Str(Dictionary<string, object> d, string k, string def)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v is string ? (string)v : def;
        }

        public static double Num(Dictionary<string, object> d, string k, double def)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return def;
            try { return Convert.ToDouble(v); } catch { return def; }
        }

        public static bool Has(Dictionary<string, object> d, string k)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v != null;
        }

        public static bool Bool(Dictionary<string, object> d, string k, bool def)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) && v is bool ? (bool)v : def;
        }

        public static Dictionary<string, object> Obj(Dictionary<string, object> d, string k)
        {
            object v;
            return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null;
        }
    }
}
