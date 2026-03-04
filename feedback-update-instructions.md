# Feedback Mechanism Update — Step-by-Step Instructions

## What's Changing

Two things are being updated:

1. **`shared/crossing.js`** on GitHub — updated `computeClosures()` and `sendFeedback()` functions
2. **Google Apps Script** in your spreadsheet — updated to handle the richer data payload

No changes needed to: `portslade/index.html`, `crossing.css`, `crossings.json`, `siri.js`, or any other file.

---

## Step 1: Update `shared/crossing.js` on GitHub

1. Go to https://github.com/richbroad29/rail-crossing
2. Navigate to `shared/crossing.js`
3. Click the **pencil icon** (Edit this file) in the top right
4. **Select all** the content (Ctrl+A / Cmd+A) and **delete it**
5. Open the `crossing.js` file I've provided and **copy the entire contents**
6. **Paste** it into the GitHub editor
7. Scroll down and click **"Commit changes"**
8. In the commit message, type something like: `Update feedback mechanism with full state snapshot`
9. Click **"Commit changes"** to confirm

The GitHub Pages site will automatically rebuild in about 30–60 seconds.

---

## Step 2: Prepare Your Google Sheet

1. Open your **"Crossing Feedback"** Google Sheet
2. **Rename the current tab** to "Old Feedback" (right-click the tab at the bottom → Rename). This preserves your existing data.
3. **Create a new tab** — click the **+** at the bottom left. Name it "Feedback v2".
4. In the new tab, paste these headers across Row 1:

```
A:  Timestamp
B:  Crossing ID
C:  Crossing Name
D:  Event
E:  Predicted Status
F:  Closure ID
G:  Current Closure Start
H:  Current Closure End
I:  Current Closure Train Count
J:  Current Closure Reason
K:  Current Closure Trains (JSON)
L:  Prev Closure ID
M:  Prev Closure Start
N:  Prev Closure End
O:  Prev Closure Train Count
P:  Next Closure ID
Q:  Next Closure Start
R:  Next Closure End
S:  Next Closure Train Count
T:  Next Closure Trains (JSON)
U:  Last Train Time
V:  Last Train Direction
W:  Last Train Route
X:  Last Train Secs Ago
Y:  Next Train Time
Z:  Next Train Direction
AA: Next Train Route
AB: Next Train Secs Away
AC: Param Close Before (mins)
AD: Param Open After (mins)
AE: Param Consecutive Window (mins)
```

5. **Make sure "Feedback v2" is the first (leftmost) tab**, or move it there by dragging. The Apps Script writes to the active/first sheet by default.

---

## Step 3: Update the Google Apps Script

1. In the same Google Sheet, go to **Extensions → Apps Script**
2. **Delete ALL** the existing code in the editor
3. Open the `apps-script.js` file I've provided and **copy the entire contents**
4. **Paste** it into the Apps Script editor
5. Click **Save** (Ctrl+S / Cmd+S)
6. Click **Deploy → Manage deployments**
7. Click the **pencil icon** (Edit) on your existing deployment
8. Under **"Version"**, change it to **"New version"**
9. Click **Deploy**
10. You should see a confirmation. The URL stays the same.

**CRITICAL:** You must create a **new version** in step 8. If you skip this, the old code keeps running even though you saved the new code. This is the most common mistake.

---

## Step 4: Test It

1. Open your crossing app: https://richbroad29.github.io/rail-crossing/portslade/
2. Wait for it to load live data
3. Tap **"Barriers Closing Now"**
4. Check your Google Sheet — a new row should appear in the "Feedback v2" tab with all 31 columns populated
5. Tap **"Barriers Opening Now"**
6. Check the sheet again — the new row should have the **same Closure ID** (column F) as the previous row, because both events belong to the same closure episode

If the data arrives in the old tab or doesn't arrive at all, check that "Feedback v2" is the first/active tab and that you deployed a new version of the Apps Script.

---

## How to Use the Data for Calibration

### Pairing Close/Open Events
Filter column F (Closure ID). A "closing" event and an "opening" event with the same ID belong to the same barrier episode. The time difference between them is the **actual closure duration**.

### Calibrating the Close-Before Offset
For each "closing" event:
- Column A = when barriers actually started closing
- Column Y = next train's predicted time
- The difference = actual close-before time
- Compare against column AC (the model's parameter, currently 1.5 mins)

### Calibrating the Open-After Offset
For each "opening" event:
- Column A = when barriers actually finished opening
- Column U = last train's predicted time
- The difference = actual open-after time
- Compare against column AD (the model's parameter, currently 0.75 mins)

### Detecting Dwell Behaviour
For "opening" events where column V (Last Train Direction) is "west" (train arrived at Portslade from Brighton direction, stopping then departing towards coast):
- Column X (Last Train Secs Ago) tells you how long after the predicted arrival the barriers actually opened
- If this is consistently 2–3 minutes rather than 45 seconds, it means barriers stay down during the station dwell

### Checking Consecutive Merge Accuracy
Look for "opening" events where column I (Current Closure Train Count) > 1 and column J = "merged_consecutive". If someone reports "opening" in the **middle** of what you predicted would be a single merged closure, the merge was wrong — the signaller actually cycled the barriers between trains.

### Checking if Your Consecutive Window Is Too Narrow
If you see a "closing" event where the Closure ID matches the **next** closure (column P) rather than the current closure (column F being empty), it means barriers came down during what you predicted would be an open gap. Your consecutive window needs to be wider.
