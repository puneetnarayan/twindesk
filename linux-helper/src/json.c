// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// A tiny JSON reader/writer for our messages: objects of strings, numbers, booleans and nested
// objects (arrays are skipped). No library.
#include "helper.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { const char *p; } Rd;

static void ws(Rd *r) { while (*r->p == ' ' || *r->p == '\t' || *r->p == '\n' || *r->p == '\r') r->p++; }

static char *read_str(Rd *r) {
  if (*r->p != '"') return NULL;
  r->p++;
  size_t cap = 32, n = 0;
  char *s = malloc(cap);
  while (*r->p && *r->p != '"') {
    char c = *r->p++;
    if (c == '\\') {
      c = *r->p++;
      switch (c) {
        case 'n': c = '\n'; break;
        case 't': c = '\t'; break;
        case 'r': c = '\r'; break;
        case 'b': c = '\b'; break;
        case 'f': c = '\f'; break;
        case 'u': { // BMP only, as UTF-8
          unsigned v = 0;
          for (int i = 0; i < 4 && *r->p; i++) { char h = *r->p++; v = v * 16 + (h >= 'a' ? h - 'a' + 10 : h >= 'A' ? h - 'A' + 10 : h - '0'); }
          char u[3]; int k = 0;
          if (v < 0x80) u[k++] = (char)v;
          else if (v < 0x800) { u[k++] = (char)(0xC0 | (v >> 6)); u[k++] = (char)(0x80 | (v & 0x3F)); }
          else { u[k++] = (char)(0xE0 | (v >> 12)); u[k++] = (char)(0x80 | ((v >> 6) & 0x3F)); u[k++] = (char)(0x80 | (v & 0x3F)); }
          for (int i = 0; i < k; i++) { if (n + 2 >= cap) s = realloc(s, cap *= 2); s[n++] = u[i]; }
          continue;
        }
        case 0: r->p--; c = 0; break;
        default: break; // \" \\ \/
      }
      if (!c) break;
    }
    if (n + 2 >= cap) s = realloc(s, cap *= 2);
    s[n++] = c;
  }
  if (*r->p == '"') r->p++;
  s[n] = 0;
  return s;
}

static JObj *read_obj(Rd *r, int depth);

static void skip_value(Rd *r, int depth);

static int read_val(Rd *r, JVal *v, int depth) {
  ws(r);
  memset(v, 0, sizeof *v);
  char c = *r->p;
  if (c == '"') { v->type = J_STR; v->str = read_str(r); return 1; }
  if (c == '{') { v->type = J_OBJ; v->obj = read_obj(r, depth + 1); return v->obj != NULL; }
  if (c == 't' && !strncmp(r->p, "true", 4)) { v->type = J_BOOL; v->num = 1; r->p += 4; return 1; }
  if (c == 'f' && !strncmp(r->p, "false", 5)) { v->type = J_BOOL; v->num = 0; r->p += 5; return 1; }
  if (c == 'n' && !strncmp(r->p, "null", 4)) { v->type = J_NULL; r->p += 4; return 1; }
  if (c == '-' || (c >= '0' && c <= '9')) {
    char *end;
    v->type = J_NUM;
    v->num = strtod(r->p, &end);
    r->p = end;
    return 1;
  }
  if (c == '[') { v->type = J_OTHER; skip_value(r, depth + 1); return 1; }
  return 0;
}

static void skip_value(Rd *r, int depth) {
  ws(r);
  if (depth > 16) { r->p += strlen(r->p); return; }
  if (*r->p == '[') {
    r->p++;
    for (;;) {
      ws(r);
      if (*r->p == ']') { r->p++; return; }
      if (!*r->p) return;
      JVal v;
      if (!read_val(r, &v, depth)) { r->p += strlen(r->p); return; }
      if (v.type == J_STR) free(v.str);
      if (v.type == J_OBJ) json_free(v.obj);
      ws(r);
      if (*r->p == ',') r->p++;
    }
  }
}

static JObj *read_obj(Rd *r, int depth) {
  ws(r);
  if (*r->p != '{' || depth > 16) return NULL;
  r->p++;
  JObj *o = calloc(1, sizeof *o);
  for (;;) {
    ws(r);
    if (*r->p == '}') { r->p++; return o; }
    char *k = read_str(r);
    if (!k) break;
    ws(r);
    if (*r->p != ':') { free(k); break; }
    r->p++;
    JVal v;
    if (!read_val(r, &v, depth)) { free(k); break; }
    if (o->n < J_MAX) { o->keys[o->n] = k; o->vals[o->n] = v; o->n++; }
    else { free(k); if (v.type == J_STR) free(v.str); if (v.type == J_OBJ) json_free(v.obj); }
    ws(r);
    if (*r->p == ',') r->p++;
  }
  json_free(o);
  return NULL;
}

JObj *json_parse(const char *s) {
  Rd r = { s };
  return read_obj(&r, 0);
}

void json_free(JObj *o) {
  if (!o) return;
  for (int i = 0; i < o->n; i++) {
    free(o->keys[i]);
    if (o->vals[i].type == J_STR) free(o->vals[i].str);
    if (o->vals[i].type == J_OBJ) json_free(o->vals[i].obj);
  }
  free(o);
}

static const JVal *get(const JObj *o, const char *k) {
  if (!o) return NULL;
  for (int i = 0; i < o->n; i++) if (!strcmp(o->keys[i], k)) return &o->vals[i];
  return NULL;
}

int jhas(const JObj *o, const char *k) { const JVal *v = get(o, k); return v && v->type != J_NULL; }
const char *jstr(const JObj *o, const char *k, const char *def) { const JVal *v = get(o, k); return v && v->type == J_STR ? v->str : def; }
double jnum(const JObj *o, const char *k, double def) { const JVal *v = get(o, k); return v && (v->type == J_NUM || v->type == J_BOOL) ? v->num : def; }
int jbool(const JObj *o, const char *k, int def) { const JVal *v = get(o, k); return v && v->type == J_BOOL ? (int)v->num : def; }
JObj *jobj(const JObj *o, const char *k) { const JVal *v = get(o, k); return v && v->type == J_OBJ ? v->obj : NULL; }

// ---- writer ----

static void put(JOut *o, const char *s) {
  size_t n = strlen(s);
  if (o->len + n + 2 >= sizeof o->buf) return;
  memcpy(o->buf + o->len, s, n);
  o->len += n;
  o->buf[o->len] = 0;
}

static void key(JOut *o, const char *k) {
  if (!o->first) put(o, ",");
  o->first = 0;
  put(o, "\"");
  put(o, k);
  put(o, "\":");
}

void jo_begin(JOut *o) { o->len = 0; o->buf[0] = 0; o->first = 1; put(o, "{"); }

void jo_str(JOut *o, const char *k, const char *v) {
  key(o, k);
  put(o, "\"");
  char e[8];
  for (const unsigned char *p = (const unsigned char *)v; *p; p++) {
    if (*p == '"' || *p == '\\') { e[0] = '\\'; e[1] = (char)*p; e[2] = 0; put(o, e); }
    else if (*p < 0x20) { snprintf(e, sizeof e, "\\u%04x", *p); put(o, e); }
    else { e[0] = (char)*p; e[1] = 0; put(o, e); }
  }
  put(o, "\"");
}

void jo_num(JOut *o, const char *k, double v) {
  char b[40];
  if (v == (long long)v && v > -1e15 && v < 1e15) snprintf(b, sizeof b, "%lld", (long long)v);
  else snprintf(b, sizeof b, "%.6g", v);
  key(o, k);
  put(o, b);
}

void jo_bool(JOut *o, const char *k, int v) { key(o, k); put(o, v ? "true" : "false"); }
void jo_raw(JOut *o, const char *k, const char *json) { key(o, k); put(o, json); }
const char *jo_end(JOut *o) { put(o, "}"); return o->buf; }
