# Mycroscope — Setup & Installation Guide

Mycroscope records how work computers are used (apps, websites, and active/idle time) so managers can see
productivity, while keeping employees informed and in control as required by POPIA and RICA.

There are **two parts**:

1. **The manager app** — a website for owners and managers (and employees who want to see their own activity).
2. **The desktop agent** — a small Windows program installed on each work computer.

**Set them up in this order:** first create your organisation and register your employees in the manager app,
**then** install the desktop agent on the computers. Doing it the other way around will not work, because each
employee needs a code from the manager app before they can activate the agent.

---

# Part 1 — For the owner / manager (do this first)

## Step 1. Open the manager app

Go to **https://mycroscope.netlify.app** for the public website, then choose **Get started** or open **https://mycroscope.netlify.app/sign-in**. After you sign in, the dashboard is **https://mycroscope.netlify.app/overview**.

- On a phone you can tap your browser's **Add to Home Screen** to use it like an app.

## Step 2. Create your organisation

1. On the sign-in screen, choose **Register** (create an organisation).
2. Enter your organisation name, your full name, your work email, and a password.
3. Tick the box confirming you may act for the organisation, then select **Create organisation**.
4. Open the confirmation email and click the link, then come back and sign in.

You are now the **owner**. New organisations start on the free plan: 3 people and 30 days of detailed activity.

## Step 3. (Optional) Add other managers

If other people need to see reports, add them as managers: **Register Employee**, and set their role to Manager.

## Step 4. Register your employees

For every person whose computer will be monitored:

1. Go to **Register Employee**.
2. Enter their name and work email.
3. You will receive two codes for that employee:
   - an **Employee code** (for example `AL0001`)
   - a one-time **Activation code**
4. Write these down for each employee. They need both to activate the agent on their computer.

> Tip: register everyone first, so you have all the codes ready before installing.

## Step 5. Get the company install key

1. Go to **Settings → Organisation → Agent install key**.
2. You will see a key like **`MYC-XXXX-XXXX-XXXX-XXXX`**.
3. This same key is used to install the agent on **every** computer in your organisation. Keep it with
   management — an employee cannot reinstall the agent without it.

## Step 6. Review the monitoring notice (important for POPIA/RICA)

Go to **Settings → Monitoring & privacy** and check what is recorded, your working hours, and the notice text.
Every employee must read and accept this notice on their computer before tracking begins. As the owner you are
responsible for telling your staff that monitoring takes place.

## Step 7. Upgrade when you need more

The free plan includes 3 people and 30 days of detailed activity. Open **Settings → Subscription & billing** to
compare plans, then **Get plan** to see the yearly total before you pay. The price on the card is per person
per month, before VAT, and you pay 12 months at once. The amount you pay includes 15% VAT. An upgrade starts after
the payment is confirmed. Coming back from the payment page is not enough on its own. A downgrade starts at the
end of the year. People are not deleted.

---

# Part 2 — For each employee (install on the work computer)

**What you need from your manager before you start:**

- the **Mycroscope Setup** file (`Mycroscope-Setup.exe`),
- the **company install key** (`MYC-XXXX-XXXX-XXXX-XXXX`),
- your **employee code** and **activation code**.

**Requirements:** Windows 10 or 11 (64-bit). No administrator rights are needed for a personal computer.

## Step 1. Run the installer

1. Double-click **`Mycroscope-Setup.exe`**.
2. Windows may show a blue warning, **“Windows protected your PC.”** This is normal for a new program.
   Click **More info**, then **Run anyway**.
3. When asked, type the **company install key** your manager gave you, then continue.
4. Click **Install**, then **Finish**. Mycroscope opens automatically.

## Step 2. Activate your account

1. In the Mycroscope window, choose **Activate**.
2. Enter your **employee code**, your **activation code**, your work **email**, and a **password** you choose.
3. Select **Activate**.

## Step 3. Read and accept the monitoring notice

Read the notice explaining what is recorded, then tick the box and select **I understand and agree**.
Tracking now begins.

That's it. From now on Mycroscope starts automatically when you turn on the computer and sits quietly in the
system tray (near the clock). You can open it any time from the tray icon to pause (if allowed) or sign out.

---

# Everyday use & good to know

- **Starts on its own:** after setup, the agent runs each time you sign in to Windows.
- **Sign-in reminder:** if nobody is signed in while the computer is being used, a reminder window keeps
  appearing until someone signs in. Managers are alerted if a computer is used for 15 minutes with nobody
  signed in.
- **Your privacy:** employees can sign in at **https://mycroscope.netlify.app/sign-in** to see only their own activity
  and to send privacy requests (for example, ask for a copy of their data).
- **Uninstalling:** on a personal computer you can remove it from **Windows Settings → Apps**. Your manager is
  notified when the agent is removed or stops reporting.

---

# Troubleshooting

**“That install key is not valid.”**
Check the key with your manager (Settings → Organisation → Agent install key). It must be typed exactly.

**“Invalid activation details” when activating.**
The employee code or activation code is wrong, or the activation code has expired. Ask your manager to check
them or issue a new activation code.

**I didn't get the email confirmation (owner sign-up).**
Check your spam folder. You can also ask for the link to be resent from the sign-in screen.

**The window keeps popping up.**
That is the sign-in reminder. Sign in with your employee details to stop it.

**Need help?**
Contact your Mycroscope administrator (the person who sent you this guide).
