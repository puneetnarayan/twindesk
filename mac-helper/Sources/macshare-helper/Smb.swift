// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Mount / unmount the PC's SMB share with the NetFS framework: the password is passed
// in-process, never on a command line. Mounts under /Volumes/<share> (shows in Finder's sidebar).
import Foundation
import NetFS

enum Smb {
  static func mount(url: String, user: String, password: String, done: @escaping (Result<String, HelperError>) -> Void) {
    guard let u = URL(string: url) else { return done(.failure(HelperError(message: "bad url"))) }
    DispatchQueue.global().async {
      let open = NSMutableDictionary()
      open[kNAUIOptionKey] = kNAUIOptionNoUI // never show a login window
      let mountOpts = NSMutableDictionary()
      var points: Unmanaged<CFArray>?
      let rc = NetFSMountURLSync(u as CFURL, nil, user as CFString, password as CFString, open, mountOpts, &points)
      let paths = (points?.takeRetainedValue() as? [String]) ?? []
      DispatchQueue.main.async {
        if rc == 0, let p = paths.first { return done(.success(p)) }
        // 17 (EEXIST): already mounted — find it under /Volumes.
        done(.failure(HelperError(message: rc == 17 ? "already mounted" : "mount failed (\(rc)): \(String(cString: strerror(rc)))")))
      }
    }
  }

  static func unmount(path: String) -> String? {
    guard path.hasPrefix("/Volumes/") else { return "not a /Volumes path" }
    return Darwin.unmount(path, 0) == 0 ? nil : String(cString: strerror(errno))
  }
}
