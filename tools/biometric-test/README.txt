StartupTN HR - Biometric test (one time, read-only)
====================================================

What it does
  Asks the Chennai eTimeTrackLite server for yesterday's and today's punches and saves
  exactly what it sends back. It does NOT change anything on the biometric system.
  It saves no password.

Where to run it
  On the PC that runs eTimeTrackLite (best), or any office PC on the same network.

Before you start, have ready (from the eTimeTrackLite admin)
  1. The web service address. On the eTimeTrackLite PC it is usually:
       http://localhost/iclock/WebAPIService.asmx
     From another PC, use that PC's address instead of localhost, e.g.
       http://192.168.1.140/iclock/WebAPIService.asmx
     Tip: open the address in a browser. You should see a page listing "GetTransactionsLog".
  2. The device serial number (eTimeTrackLite > Devices).
  3. An eTimeTrackLite user name and password that can read logs.

Steps (about 3 minutes)
  1. Unzip this folder to the Desktop.
     If Windows says the files are blocked: right-click the zip > Properties > tick Unblock > OK,
     then unzip again.
  2. Double-click Run-Test.bat.
     If a blue "Windows protected your PC" box appears: click More info > Run anyway.
  3. Answer the questions (press Enter to accept a value shown in [brackets]).
  4. Optional speed test: type y, punch once on the device, press Enter.
     It shows how many seconds a punch takes to reach the server.
  5. When it says Done, send the zip it made on the Desktop
     (stn-biometric-test-<date>.zip) to Naveen.

If something fails
  Send the zip anyway. The file 0-summary.txt inside says what went wrong.
