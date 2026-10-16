import { Text } from 'react-native';

import { styles } from '@/components/ui';

function H({ children }: { children: string }) {
  return <Text style={[styles.sectionTitle, { fontSize: 16, marginTop: 8 }]}>{children}</Text>;
}

function P({ children }: { children: string }) {
  return <Text style={styles.rowText}>{children}</Text>;
}

/** Privacy policy shown inside the app. Keep it aligned with site/privacy.html. */
export function PrivacyText() {
  return (
    <>
      <Text style={styles.hint}>Effective 16 October 2026</Text>
      <P>This policy explains what Mycroscope does with personal information. It covers the public website, the signed-in app, and the Windows desktop app. It is written for the Protection of Personal Information Act (POPIA). It is not legal advice for your organisation.</P>
      <H>1. Two roles</H>
      <P>When a company uses Mycroscope to record its people, that company decides why the recording happens and what the monitoring notice says. Under POPIA, that company is the responsible party for the activity records.</P>
      <P>Mycroscope stores and shows those records so the company can run the product. For that activity, Mycroscope is an operator. Mycroscope does not use a customer’s activity to advertise, and Mycroscope staff cannot open the contents of a customer’s activity.</P>
      <P>Mycroscope is the responsible party for its own account, billing, and support records.</P>
      <H>2. Information the product stores</H>
      <P>Account: name, email address, organisation name, role, a password held by the sign-in service, and an optional authenticator code. Invitations and activation codes are stored until they are used or they expire.</P>
      <P>After a person acknowledges the company’s monitoring notice, the desktop app can store active, idle, and away time; the application name and the website; the window title and the full web address only if the company turns that on; and answers for meetings, calls, breaks, or other time away when that prompt is on.</P>
      <P>On Workforce Management it can store the names and sizes of files copied to a removable drive, a cloud folder, or a network drive, and that a phone or other drive was connected. File contents are not read. Files copied onto a phone are not listed. The computer name, operating system, agent version, and last check-in are stored.</P>
      <P>Billing: plan, number of people, amount, currency, payment reference, and the invoice. Card numbers are handled by the card payment provider. Mycroscope does not store the card number.</P>
      <P>Support: the name, email, organisation, topic, and message sent on the support form. Hosting and database services keep ordinary logs, such as IP address and request time. The audit log records sensitive actions, including when a manager opens another person’s detail.</P>
      <H>3. What is not collected</H>
      <P>Mycroscope does not photograph the screen, does not read documents or email bodies, and does not sell personal information. A short support window, if the organisation turns it on, shows agent status only.</P>
      <H>4. Why it is used</H>
      <P>To create and secure the account, to record and show activity as the notice describes, to produce reports from figures already stored, to charge for the plan, to answer support questions, and to investigate abuse. The company must have its own lawful basis for monitoring. Mycroscope’s basis for account, billing, and support information is the contract with the organisation.</P>
      <H>5. Who can see activity</H>
      <P>The person can open their own activity on every plan, including Free. Owners, and managers allowed to see that person, can open the wider record. Live status is included from Work Activity Tracking upward. On Free, a manager sees the name and today’s active and idle time. Mycroscope operators can suspend, restore, or, after cancellation, delete an account. They cannot read activity contents.</P>
      <H>6. How long it is kept</H>
      <P>Detailed activity is kept for 30 days on Free, 6 months on Work Activity Tracking and Workforce Management, and 12 months on Productivity Optimization. The owner can choose a shorter period. Names and sizes of copied files follow the company’s file-retention setting, from 7 to 365 days, default 30. Invoices are kept for as long as tax and accounting rules require. Deleting the organisation is available only after the subscription is cancelled, and it cannot be undone.</P>
      <H>7. Service providers</H>
      <P>Supabase runs the database, sign-in, and server functions. The host that runs the Mycroscope containers serves the website and the signed-in web app, and keeps support questions until they are answered. The card payment provider handles the payment page and does not pass the card number to Mycroscope. An email provider sends manager or billing email only when that provider is connected. These providers may process information outside South Africa.</P>
      <H>8. Security and rights</H>
      <P>Access to another person’s record is limited by role and team, and those views are written to the audit log. Owners can require two-factor login for managers. An employee who wants to see, correct, or object to activity should start with their employer. For Mycroscope’s own account, billing, or support records, use the support form. You may also complain to the Information Regulator of South Africa.</P>
      <H>9. Children, storage, and changes</H>
      <P>Mycroscope is a workplace product and is not directed at children. The signed-in app stores the sign-in session in the browser. If this policy changes, the new version is posted with a new effective date.</P>
    </>
  );
}

/** Terms of service shown inside the app. Keep them aligned with site/terms.html. */
export function TermsText() {
  return (
    <>
      <Text style={styles.hint}>Effective 16 October 2026</Text>
      <P>These terms are the agreement between Mycroscope and the organisation that opens an account, and they also apply to each person who signs in. By creating an account, installing the desktop app, or paying for a plan, the organisation agrees to these terms and to the privacy policy.</P>
      <P>The person who creates the account must be allowed to do that for the organisation.</P>
      <H>1. The service</H>
      <P>Mycroscope provides a website, a signed-in app, and a Windows desktop app that record computer activity the organisation has described in its monitoring notice. Features depend on the plan. A feature that is not in the plan is hidden. Mycroscope does not photograph the screen and does not give legal, human-resources, or payroll advice. The figures show what was recorded. They are not a finding about a person’s conduct.</P>
      <H>2. Accounts and the desktop app</H>
      <P>The owner invites people. Each person activates the desktop app with an activation code and the company install key. The organisation must keep the install key inside the company. Recording follows the current monitoring notice. Changing what is collected publishes a new notice, and people are asked to acknowledge the new version.</P>
      <H>3. The organisation’s duties</H>
      <P>The organisation will use Mycroscope only where it has a lawful basis, tell the people being recorded, name an information officer in the product when it is required to have one, and not use the product to collect information the notice does not describe. It will not attack the service or try to view another organisation’s data.</P>
      <H>4. Plans and payment</H>
      <P>Prices are per seat, per month, before VAT. At checkout the owner chooses how many seats to buy. A seat is charged once for a year: monthly price times 12, with VAT added when VAT is on. A seat added later is charged for its own year, with VAT, and ends on its own date. Removing a seat waits until that date, and the unused time is not refunded. Returning from the payment page is not proof that the payment succeeded. The seats are added when the payment provider confirms it.</P>
      <P>Free is R0, for up to 3 active people, and keeps 30 days of activity. Moving from Free to a paid plan charges a full year. Moving to a higher paid plan during the year charges the price difference for the days left. A downgrade or cancellation takes effect at the end of the paid year. Amounts already paid are not refunded. If a renewal is not paid, the paid plan stays for 7 days and the account then moves to Free. People above the Free limit are paused. They are not deleted.</P>
      <H>5. Customer data and Mycroscope’s rights</H>
      <P>The organisation keeps its rights in the records it puts into Mycroscope and gives Mycroscope permission to host and display them so the service can run. Mycroscope staff do not read activity contents. Mycroscope owns the software. The organisation may use it for its own workforce while the account is open and these terms are kept.</P>
      <H>6. Availability, suspension, and ending</H>
      <P>The service is not promised to be uninterrupted. Mycroscope may suspend an organisation that does not pay, that breaks these terms, or that puts other customers or the service at risk. A suspended account can open existing data and cannot record new activity. The organisation may cancel. Recording continues until the paid-until date if that date is still in the future. Cancellation does not refund the current year.</P>
      <H>7. Liability</H>
      <P>To the extent the law allows, Mycroscope is not liable for lost profits or for a decision the organisation makes about a person from a report. Mycroscope’s total liability in a year is limited to the fees that organisation paid for the 12 months before the claim. Nothing in these terms limits liability for fraud, or for harm that South African law does not allow a contract to exclude.</P>
      <P>The organisation will cover Mycroscope against a claim by one of its people, or by a regulator, that arises from the organisation’s monitoring, its notice, or its use of a report, except to the extent Mycroscope caused the claim by failing to run the service as these terms and the privacy policy describe.</P>
      <H>8. Law and changes</H>
      <P>These terms are governed by the law of the Republic of South Africa. A new version is posted with a new effective date. Continued use after that date is acceptance. A change to price applies to the next year, or to an upgrade, and is shown before payment.</P>
    </>
  );
}
