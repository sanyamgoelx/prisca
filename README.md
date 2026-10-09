# Prisca

Fast scanning for any scanner or all-in-one printer on Windows (Pri + Sca: Printer + Scanner). A modern replacement for the scan software that came with the printer.

- **Space** scans the next page. Pages pile up in the batch on the left, already cropped and straightened.
- Presets: Document (grey, 200 dpi), Receipt (black and white, 300 dpi), Photo (colour, 300 dpi). Resolution is adjustable.
- Per page: colour mode, auto-enhance, brightness, contrast, sharpness, B&W threshold, turn, crop and straighten. **Apply to all pages** copies the settings.
- Save as one PDF (searchable: Windows' own text recognition adds a hidden text layer; page size snaps to A4/Letter), or a JPG/PNG per page. Names like `Scan 2026-10-09 001`, saved in `Documents\Prisca` (changeable).
- **Print** the batch, or **Copy**: scan and print in one press.
- Scanners with a document feeder get a Glass/Feeder choice; the feeder scans every page in one go and skips blank sheets.
- **Several items at once**: lay receipts, cards or photos on the glass with a gap between them, pick *Several items*, and each becomes its own straightened page (one scan instead of four).
- **Book mode**: *Book: 2 pages* splits an open book or notebook at the gutter into two pages, in reading order. The split button (toolbar) does the same for a page already scanned.
- Pages are turned upright automatically (reads the text), and the scanner's colour tint is removed.
- File names come from the first page when it has a clear title, e.g. `Invoice 1043 2026-10-09`.
- Black-and-white pages are saved as true black and white: PDFs about a tenth of the size.
- **Report a problem** (scanner menu, or on a scan error) opens a pre-filled GitHub issue and saves a scanner report to attach.
- Drop pictures (or **Add pictures**) to clean up photos of documents the same way.
- Updates install themselves.

## Download
Get `Prisca_…_x64-setup.exe` from [Releases](../../releases/latest). Windows may say "Windows protected your PC": click *More info* › *Run anyway*.

## How it talks to the scanner
Through Windows Image Acquisition (WIA), which every scanner driver on Windows provides. No vendor software needed; the scanner only needs its Windows driver. `check-scanner.cmd` lists what Windows can see; the scanner menu in Prisca can save a scanner report for odd drivers.

## Keys
Space scan · Shift+Space scan the current page again · Esc cancel scan · Ctrl+S save · Ctrl+Shift+S save and start a new batch · Ctrl+P print · R / Shift+R turn · C crop · Delete remove page (Ctrl+Z brings it back) · ↑ ↓ pick page

## Build
- `run-dev.cmd`: start a development build.
- `build.cmd`: make the installer in `dist\`.
- `release.cmd`: publish the version in `src-tauri\tauri.conf.json` (GitHub builds it; installed copies update).
Needs Node.js, Rust and the Visual Studio C++ build tools.

## Licence
GPL-3.0-or-later. Fonts: IBM Plex (SIL Open Font License, `ui/fonts/OFL.txt`).
