# Prisca

Printing and scanning for any printer, scanner or all-in-one on Windows (Pri + Sca: Printer + Scanner). A modern replacement for the software that came with the printer. Two modes, **Print** (Ctrl+1) and **Scan** (Ctrl+2).

## Print
- **Print job**: add PDFs, pictures and your scans; pick pages from each (click pages, or All / None / Odd / Even), turn pages, reorder files, and print them all in one go. Each file starts on a new sheet, or runs on from the last. **Save as one PDF** keeps the picked pages as a file instead.
- **Print again**: every printed job is kept (the last 20) with its pages and settings, to print again in one click.
- **The printer's queue**: see what's waiting, cancel one job or all, spot stuck ones.
- **Line up the printer** (under the printer name): Prisca prints a test page with five dots, you scan it back with Prisca (lid open), and it measures where the dots landed against the paper's edges. Every print on that printer is shifted back by that from then on. A guide walks you through it.
- **Pack** (pages per sheet): several receipts, cards or tickets on one sheet at their real size, with dashed lines to cut along.
- Drag page thumbnails to put pages in a different order, or onto another file to move them there.
- Settings are shared with the print panel below (margins in mm, anchor, setups…).

## Scan

- **Space** scans the next page. Pages pile up in the batch on the left, already cropped and straightened.
- The batch: page numbers sit on the pages, small marks show what you changed (B&W, cropped, turned, adjusted), hover a page to turn it, **Ctrl+click** or **Shift+click** to pick several and turn, print or remove them together, **Ctrl+scroll** for 1, 2 or 3 columns. The header shows roughly how big the file will be, and a page that looks like a second scan of another gets a *Same as 2?* badge.
- Presets: Document (grey, 200 dpi), Receipt (black and white, 300 dpi), Photo (colour, 300 dpi). Resolution is adjustable.
- Per page: colour mode, auto-enhance, brightness, contrast, sharpness, B&W threshold, turn, crop and straighten. **Apply to all pages** copies the settings.
- Save as one PDF (searchable: Windows' own text recognition adds a hidden text layer; page size snaps to A4/Letter), or a JPG/PNG per page. Names like `Scan 2026-10-09 001`, saved in `Documents\Prisca` (changeable).
- **Print** with Prisca's own print panel: margins in mm (all four linked or each on its own), Fit / Fill / True size / Custom %, and an **anchor** (3×3 grid) that sets where the page sits and grows from: top centre, centre, bottom right… Plus 1, 2 or 4 pages per sheet, Colour / Grey / Draft, copies, page ranges, and **both sides by hand** for printers that can't turn paper over. The preview shows the edge the printer can't reach and warns when part of a page would be lost. Settings are remembered per printer, and named setups (*Receipt on A4*, *ID card copy*, …) are one click. **Ctrl+Shift+P** prints straight away with the last settings; **Copy** scans and prints in one press.
- Scanners with a document feeder get a Glass/Feeder choice; the feeder scans every page in one go and skips blank sheets.
- **Several items at once**: lay receipts, cards or photos on the glass with a gap between them, pick *Several items*, and each becomes its own straightened page (one scan instead of four).
- **Book mode**: *Book: 2 pages* splits an open book or notebook at the gutter into two pages, in reading order. The split button (toolbar) does the same for a page already scanned.
- Pages are turned upright automatically (reads the text), and the scanner's colour tint is removed.
- File names come from the first page when it has a clear title, e.g. `Invoice 1043 2026-10-09`.
- Black-and-white pages are saved as true black and white: PDFs about a tenth of the size.
- **Report a problem** (scanner menu, or on a scan error) opens a pre-filled GitHub issue and saves a scanner report to attach.
- Drop pictures (or **Add pictures or PDFs**) to clean up photos of documents the same way. **PDFs** open as pages at their real size (Windows' own PDF renderer), untouched, ready to print with Prisca's margins and anchor.
- **Prisca as a printer** (scanner menu › *Add Prisca as a printer…*, Windows asks for permission once): pick *Prisca* in any app's print dialog (Chrome / Google Drive: *Destination › See more*) and the document opens in Prisca's print panel. Prisca opens by itself when a job arrives.
- **Right-click menu**: *Print with Prisca* and *Open in Prisca* on PDFs and pictures (Windows 11: under *Show more options*). Can be turned off in the scanner menu.
- **ID card copy** (layout menu): scan the front, turn the card over, scan the back; both land on one page at their real size, ready for the *ID card copy* print setup.
- Saving: a **size limit** for upload forms (under 200 KB / 500 KB / 1 MB: Prisca lowers picture quality, then resolution), **sort into folders by type** (the folder follows the name: Invoices, Bills, Receipts, IDs…) and **copy the file after saving** to paste into WhatsApp or an email.

## With Windows (settings menu, top right)
- Add Prisca as a printer · right-click menu · **keep Prisca in the tray** when closed · **start with Windows** (in the tray) · **Ctrl+Alt+S scans from anywhere** (off by default; only that key combination is taken).
- Updates install themselves.

## Download
Get `Prisca_…_x64-setup.exe` from [Releases](../../releases/latest). Windows may say "Windows protected your PC": click *More info* › *Run anyway*.

## How it talks to the scanner
Through Windows Image Acquisition (WIA), which every scanner driver on Windows provides. No vendor software needed; the scanner only needs its Windows driver. `check-scanner.cmd` lists what Windows can see; the scanner menu in Prisca can save a scanner report for odd drivers.

## Keys
Ctrl+1 Print · Ctrl+2 Scan · Space scan · Shift+Space scan the current page again · Esc cancel scan · Ctrl+S save · Ctrl+Shift+S save and start a new batch · Ctrl+P print · Ctrl+Shift+P print again with the last settings · R / Shift+R turn · C crop · Delete remove page (Ctrl+Z brings it back) · ↑ ↓ pick page

## Build
- `run-dev.cmd`: start a development build.
- `build.cmd`: make the installer in `dist\`.
- `release.cmd`: publish the version in `src-tauri\tauri.conf.json` (GitHub builds it; installed copies update).
Needs Node.js, Rust and the Visual Studio C++ build tools.

## Licence
GPL-3.0-or-later. Fonts: IBM Plex (SIL Open Font License, `ui/fonts/OFL.txt`).
