// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Dev only (wl-test.js): a fake mouse + keyboard through /dev/uinput, for testing the helper's
// Wayland backend without real hands. Reads commands on stdin, one per line:
//   rel <dx> <dy>      key <evdev code> <0|1>      btn <evdev code> <0|1>
// Build: gcc -O2 -o bin/fakedev dev/fakedev.c ; run as a user who may open /dev/uinput.
#include <fcntl.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static int fd;

static void ev(int type, int code, int value) {
  struct input_event ie;
  memset(&ie, 0, sizeof ie);
  ie.type = (unsigned short)type;
  ie.code = (unsigned short)code;
  ie.value = value;
  if (write(fd, &ie, sizeof ie) < 0) perror("write");
}

int main(void) {
  fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
  if (fd < 0) { perror("/dev/uinput"); return 1; }
  ioctl(fd, UI_SET_EVBIT, EV_KEY);
  ioctl(fd, UI_SET_EVBIT, EV_REL);
  ioctl(fd, UI_SET_RELBIT, REL_X);
  ioctl(fd, UI_SET_RELBIT, REL_Y);
  ioctl(fd, UI_SET_RELBIT, REL_WHEEL);
  for (int k = 1; k < 249; k++) ioctl(fd, UI_SET_KEYBIT, k);
  ioctl(fd, UI_SET_KEYBIT, BTN_LEFT);
  ioctl(fd, UI_SET_KEYBIT, BTN_RIGHT);
  struct uinput_setup us;
  memset(&us, 0, sizeof us);
  us.id.bustype = BUS_USB;
  us.id.vendor = 0x1234;
  us.id.product = 0x5678;
  strcpy(us.name, "Fake mouse and keyboard");
  ioctl(fd, UI_DEV_SETUP, &us);
  if (ioctl(fd, UI_DEV_CREATE) < 0) { perror("create"); return 1; }
  printf("ready\n");
  fflush(stdout);
  char line[128];
  while (fgets(line, sizeof line, stdin)) {
    int a, b;
    if (sscanf(line, "rel %d %d", &a, &b) == 2) { ev(EV_REL, REL_X, a); ev(EV_REL, REL_Y, b); }
    else if (sscanf(line, "key %d %d", &a, &b) == 2) ev(EV_KEY, a, b);
    else if (sscanf(line, "btn %d %d", &a, &b) == 2) ev(EV_KEY, a, b);
    else continue;
    ev(EV_SYN, SYN_REPORT, 0);
  }
  ioctl(fd, UI_DEV_DESTROY);
  return 0;
}
