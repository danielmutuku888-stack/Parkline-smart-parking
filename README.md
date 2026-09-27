# Parkline Smart Parking

Parkline is a browser-based parking lot management website for viewing parking capacity, registering vehicle arrivals, checking out vehicles, and managing parking rates and checkout records. It is designed for a single parking lot with 100 spaces: 60 cars, 30 motorcycles, and 10 trucks.

## Features

- Live dashboard showing total occupancy and capacity by vehicle type.
- Vehicle entry with plate validation and automatic assignment of an available bay.
- Parking bay register with table and grid views, vehicle filters, and occupied/free status.
- Checkout quotes based on configurable parking duration tiers.
- Checkout recording for cash, M-Pesa, or card, including an operator confirmation and optional transaction reference.
- Checkout history with payment summaries, CSV export, and record deletion.
- Rate configuration for cars, motorcycles, and trucks.
- Persistent parking state, rates, and checkout history in `parking_data.json`.

> **Payment note:** Payment methods and references are recorded by the app after an operator confirms payment. The project does not connect to an M-Pesa, bank, or card payment gateway.

## Requirements

- Windows, macOS, or Linux.
- Python 3 installed and available from a terminal as `python` or `py` on Windows.
- A modern web browser.
- No third-party Python packages are required; the backend uses the Python standard library.

The interface loads DM Sans and Space Grotesk from Google Fonts when an internet connection is available. The rest of the site is served locally.

## Run in VS Code

1. Open the project root folder in VS Code. It is the folder containing `server.py`, `Parking.py`, and `start_server.bat`.
2. Select **Terminal > New Terminal**.
3. Start the server using either command:

   ```powershell
   .\start_server.bat
   ```

   Or run Python directly:

   ```powershell
   python server.py
   ```

   If `python` is not recognized on Windows, try `py server.py`. Keep this terminal open while using the website.

4. Open [http://localhost:8765/](http://localhost:8765/) in your browser.
5. To stop the server, focus its terminal and press **Ctrl+C**.

Do not open `index.html` directly or use VS Code **Go Live**. The website needs the Python server for its pages and API. If port `8765` is already in use, stop the other process using it before starting Parkline.

### Optional Windows launcher

Double-click `open_parkline.vbs` to start `start_server.bat` and open the website in a browser. To see server output and errors, run `start_server.bat` from VS Code instead.

## Pages

| URL | Purpose |
| --- | --- |
| `/` | Occupancy dashboard and navigation |
| `/movement` | Vehicle entry and checkout workflow |
| `/register` | Parking bay table and grid |
| `/admin` | Administration navigation |
| `/admin/history` | Checkout records and CSV export |
| `/admin/rates` | Configure rates by vehicle type and duration |

## Parking rates

The default tiers are the same for each vehicle type and are denominated in Kenyan shillings (KES):

| Parking duration | Default fee |
| --- | ---: |
| Up to 30 minutes | KES 30 |
| 31-120 minutes | KES 50 |
| 121-240 minutes | KES 100 |
| 241-360 minutes | KES 300 |
| Over 360 minutes | KES 500 |

Rates can be changed on `/admin/rates`. The rates saved there are used for subsequent checkout quotes.

## Verify the backend tests

With Python installed, run this from the project root in a VS Code terminal:

```powershell
python -m unittest discover -s tests -v
```

On Windows, use `py -m unittest discover -s tests -v` if the `python` command is unavailable.

## Technologies

- **Frontend:** HTML, CSS, and vanilla JavaScript.
- **Backend:** Python's `http.server` and standard-library modules.
- **Parking logic:** Python classes and enums in `Parking.py`.
- **Persistence:** Local JSON file (`parking_data.json`).
- **Tests:** Python `unittest`.

## Project files

| File or folder | Contents |
| --- | --- |
| `index.html` | Home dashboard. |
| `app.js` | Shared browser behavior, API requests, rendering, and page interactions. |
| `styles.css` | Shared responsive styles. |
| `server.py` | HTTP server, static page routing, API endpoints, validation, rates, and JSON persistence. |
| `Parking.py` | Parking lot, vehicle, bay, ticket, fee, and command-line parking logic. |
| `parking_data.json` | Saved active tickets, checkout history, and configured rates. |
| `partials/site-shell.html` | Shared site header, navigation, and footer. |
| `movement/index.html` | Vehicle entry and checkout interface. |
| `register/index.html` | Parking bay register. |
| `admin/index.html` | Administration landing page. |
| `admin/history/index.html` | Checkout history and ledger export interface. |
| `admin/rates/index.html` | Parking rate configuration interface. |
| `start_server.bat` | Windows command script that starts the web server. |
| `open_parkline.vbs` | Windows launcher that starts the server and opens the website. |
| `tests/test_server.py` | Unit tests for checkout amount comparisons. |

## API overview

The browser app uses these endpoints on the same local server:

- `GET /api/health` and `GET /api/status` for server health and current parking state.
- `POST /api/entry` to register a vehicle and assign a bay.
- `GET /api/quote/{plate-or-bay}` and `POST /api/exit` to retrieve a checkout quote.
- `POST /api/payment` to record a confirmed checkout and release authorization.
- `POST /api/rates` to save rate tiers.
- `POST /api/history/delete` to delete selected checkout history records.

## Data and security notes

- Parking data is saved beside the application in `parking_data.json` and loaded when the server starts. Back up this file before manually editing or replacing it.
- The built-in server listens on all network interfaces at port `8765`. Use it for local development or a trusted private network only; it is not a production deployment server.
- The admin pages do not currently require authentication. Do not expose the app to an untrusted network with sensitive or real customer data.