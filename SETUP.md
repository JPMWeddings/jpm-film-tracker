# JPM Film Tracker: Setup

About 45 minutes, one time. Everything here is free. Claude can walk through each step with you live.

## What you are setting up
- **Website:** GitHub Pages hosts the site at films.jpmweddings.com.
- **Sign-in + photos:** Supabase sends the one-time sign-in emails, stores couple photos, and makes sure each couple only sees their own film.
- **Automatic updates:** a GitHub job copies client-safe info from Notion every hour.

---

## 1. Supabase (sign-in, data, photos)
1. Go to supabase.com and sign up with info@jpmweddings.com. Click **New project**, name it `jpm-film-tracker`, pick a US region, and save the database password in your password manager.
2. Open **SQL Editor > New query**, paste everything in `supabase/schema.sql`, and click **Run**.
3. **Authentication > Sign In / Providers:** keep Email on. Turn **Allow new users to sign up** OFF. (Only couples we add can sign in.)
4. **Authentication > URL Configuration:** Site URL = `https://films.jpmweddings.com`. Add the same address under Redirect URLs.
5. **Authentication > Emails > Magic Link:** subject `Your JPM film is waiting`, and paste the contents of `supabase/magic-link-email.html` as the body.
6. **Authentication > Emails > SMTP Settings:** turn on custom SMTP so emails come from you, not Supabase (the built-in sender only allows a few emails an hour).
   - Host `smtp.gmail.com`, port `465`, username `info@jpmweddings.com`
   - Password: a Google **app password** (Google Account > Security > 2-Step Verification > App passwords)
   - Sender name `JPM Weddings`, sender email `info@jpmweddings.com`
7. **Project Settings > API:** copy the **Project URL** and the **anon public** key into `docs/config.js`. Keep the **service_role** key private: it only goes into GitHub secrets (step 3), never into a file.

## 2. Notion (read-only access for the sync)
1. Go to notion.so/profile/integrations > **New integration**. Name `JPM Film Tracker`, workspace = yours, capabilities = **Read content** only. Copy the secret.
2. Open **Weddings** (Projects) > `...` > **Connections** > add `JPM Film Tracker`. Do the same on **Editing Backlog** (Post-Production).

## 3. GitHub (website + hourly sync)
1. Sign up at github.com. Create a new repository named `jpm-film-tracker` (Public is fine: there are no passwords or client data in the code).
2. Click **uploading an existing file** and drag in everything inside this `jpm-film-tracker` folder (including the hidden `.github` folder; on a Mac press Cmd+Shift+. in Finder to show it). Commit.
3. **Settings > Secrets and variables > Actions > New repository secret**, add three:
   - `NOTION_TOKEN` = the Notion secret
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = the service_role key
4. **Settings > Pages:** Source = Deploy from a branch, Branch = `main`, folder = `/docs`. Custom domain = `films.jpmweddings.com`. Tick **Enforce HTTPS** once it is available.
5. **Actions** tab: enable workflows, open **Sync film tracker from Notion**, click **Run workflow** once.

## 4. Your domain
In Squarespace > Domains > jpmweddings.com > DNS, add a record: Type `CNAME`, Host `films`, Data `<your-github-username>.github.io`. It can take up to an hour to work.

## 5. Test with a TEST couple
1. In Notion Weddings, add a row `TEST Ava + Marcus`, a past wedding date, Package, **Client Email = your own email**, tick **Film Tracker**. Link it to a TEST Editing Backlog row.
2. Run the workflow (or wait up to an hour). Open films.jpmweddings.com, enter your email, tap the link in your inbox.
3. Change the TEST Post Stage, run the workflow again, and refresh. Try **Add your photo**.

---

## Day to day
- **Give a couple access:** fill in **Client Email** (and **Client Email 2** for their partner), tick **Film Tracker**. Grecel sends them the link: films.jpmweddings.com (draft for Justin's approval).
- **Progress:** updates by itself from the Editing Backlog every hour. To update right now: GitHub > Actions > Run workflow (or ask Claude).
- **Deliver links:** paste the VidFlow link in **Client Film Link** and the client raw footage link in **Raw Footage Link** (never the proxy link). They only appear once **Episode Delivered** / **Raw Footage Delivered** dates are set. Or just tell Claude the links.
- **Delivery window:** tick **Show Delivery Window** to show an estimate (from Delivery Due, a one-month window).
- **Remove access:** untick **Film Tracker**. Their sign-in stops working at the next sync. Nothing is deleted.
- **If the sync ever fails,** GitHub emails you automatically.
- **Preview anytime:** films.jpmweddings.com/#demo shows the demo couple.
