#!/bin/sh
# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Undo smb-share.sh: remove the share, the folder ACL entry and the hidden account. Run as root.
# Usage: smb-unshare.sh <folder>
DIR="$1"; U=macshare
sharing -r MacShare >/dev/null 2>&1 || true
[ -d "$DIR" ] && chmod -a "$U allow list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit" "$DIR" 2>/dev/null || true
id "$U" >/dev/null 2>&1 && sysadminctl -deleteUser "$U" >/dev/null 2>&1 || true
echo ok
