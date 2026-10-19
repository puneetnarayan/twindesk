# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# dmgbuild settings for TwinDesk.dmg (build-dmg.sh passes app, icon and background with -D).
# The app sits on the left and Applications on the right, at the two ends of the arrow drawn in
# background.html. The window's height counts the title bar (32 points), leaving 660 x 380 of
# background; the icons sit high enough that their names still show when Finder's path bar and
# status bar are turned on.
import os.path

app = defines['app']

format = 'UDZO'
files = [app]
symlinks = {'Applications': '/Applications'}
icon = defines.get('icon')
background = defines['background']

window_rect = ((200, 140), (660, 412))
default_view = 'icon-view'
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

arrange_by = None
icon_size = 112
text_size = 13
icon_locations = {
    os.path.basename(app): (165, 224),
    'Applications': (495, 224),
}
