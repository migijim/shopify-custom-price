## ⚙️ Setup & Installation

### Prerequisites

- Node.js 18+ (for local development)
- Shopify store with Admin API access
- Serverless hosting (Vercel)

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file or set in your hosting platform:

```env

```

### 3. Theme integration

The CPCP Proxy is already installed on the store. So you don't need to do anything this step.
Your app name deployed to vercel should be "https://shopify-custom-price.vercel.app".


### 4. Deploy

**Vercel:**
```bash
vercel deploy
```

### 5. Register Webhook

After deployment, register the webhook:

```bash
curl -X POST https://shopify-custom-price.vercel.app/api/register-webhook
```

### 6. Set Up Cleanup Cron Job

Github Action is already configured.

.github/workflows/variant-cleanup.yml

Recommended: Run daily at 2 AM UTC.

---