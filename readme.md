# Google Discovery Engine Search with Workforce Identity and Multiple Identity Providers

## Introduction

This project is a Node.js Express web application that demonstrates an authentication and authorization flow involving multiple identity providers (IdPs) to securely access Google Cloud services.

The key features include:

1.  **Initial User Authentication:** Users first authenticate with Okta using the OpenID Connect (OIDC) protocol.
2.  **On-Demand Azure AD Authentication:** For specific actions (like performing a search), the user is interactively authenticated with Azure Active Directory (Azure AD / Entra ID).
3.  **Workforce Identity Federation:** The ID token obtained from Azure AD is then exchanged for a Google Cloud access token via Workforce Identity Federation. This allows Azure AD identities to securely assume roles and access Google Cloud resources without needing separate Google Cloud identities or service account keys.
4.  **Google Discovery Engine Integration:** The federated Google Cloud credential is used to authorize requests to the Google Discovery Engine API, enabling secure, identity-aware search functionality.

This setup is ideal for scenarios where an organization uses Okta, or another provider, as its primary IdP, but also Azure AD for certain user segments or applications, and needs to grant these users access to Google Cloud resources in a secure manner.

## Prerequisites

Before you can run this project, ensure you have the following set up and configured:

1.  **Node.js and npm (or yarn):**
    *   Node.js (LTS version recommended).
    *   npm (comes with Node.js) or yarn package manager.

2.  **Okta Account and OIDC Application:**
    *   An Okta developer account.
    *   An OIDC Web Application configured in Okta with:
        *   Client ID (`OKTA_CLIENT_ID`)
        *   Client Secret (`OKTA_CLIENT_SECRET`)
        *   Okta Issuer URI (`OKTA_ISSUER`)
        *   Sign-in redirect URI: `YOUR_APP_BASE_URL/authorization-code/callback` (e.g., `http://localhost:3000/authorization-code/callback`)

3.  **Azure Active Directory (Entra ID) Tenant and Application Registration:**
    *   An Azure AD tenant.
    *   An Application Registration in Azure AD with:
        *   Application (client) ID (`AZURE_CLIENT_ID`)
        *   Directory (tenant) ID (`AZURE_TENANT_ID`)
        *   A client secret (`AZURE_CLIENT_SECRET`)
        *   A "Web" platform configured with a Redirect URI: `YOUR_APP_BASE_URL/auth/azure/callback` (e.g., `http://localhost:3000/auth/azure/callback`)
        *   API permissions for Microsoft Graph (e.g., `User.Read` under Delegated permissions) or `https://graph.microsoft.com/.default`.

4.  **Google Cloud Platform (GCP) Project:**
    *   A GCP Project for this deployment (`DEPLOYED_PROJECT_ID`).
    *   **Workforce Identity Federation Configured:**
        *   A Workforce Identity Pool.
        *   An OIDC provider within that pool configured to trust your Azure AD application. The provider's audience string will be `GOOGLE_WIF_AUDIENCE`.
        *   Appropriate IAM permissions granted to the federated identities (e.g., roles/discoveryengine.viewer) to access the Discovery Engine.
    *   **Google Discovery Engine API Enabled.**
    *   A Discovery Engine Data Store/Engine created (`DISCOVERY_ENGINE_DATA_STORE_ID`).
    *   A Discovery Engine Project ID (`GOOGLE_PROJECT_ID`).

5.  **Environment Variables:** All necessary environment variables (see deployment script below) must be set in your local environment or deployment configuration.

## Environment Variables and Deployment Project
```bash
REGION=
PROJECT_ID=
PROJECT_NUMBER=
OKTA_CLIENT_ID=
OKTA_ISSUER=
OKTA_CLIENT_SECRET=
AZURE_CLIENT_ID=
AZURE_TENANT_ID=
AZURE_CLIENT_SECRET=
DISCOVERY_PROJECT_ID=
GOOGLE_WIF_AUDIENCE=
DISCOVERY_ENGINE_DATA_STORE_ID=
APP_BASE_URL=
EXPRESS_SECRET=

printf 'y' |  gcloud services enable artifactregistry.googleapis.com
printf 'y' |  gcloud services enable cloudbuild.googleapis.com
printf 'y' |  gcloud services enable run.googleapis.com

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
--member=serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com \
--role=roles/cloudbuild.builds.builder

gcloud projects add-iam-policy-binding ${PROJECT_ID} \
--member=serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com \
--role='roles/logging.logWriter'

gcloud run deploy agentspace-api-identities \
  --source . \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --project $PROJECT_ID \
  --set-env-vars="OKTA_ISSUER=$OKTA_ISSUER" \
  --set-env-vars="OKTA_CLIENT_ID=$OKTA_CLIENT_ID" \
  --set-env-vars="OKTA_CLIENT_SECRET=$OKTA_CLIENT_SECRET" \
  --set-env-vars="AZURE_CLIENT_ID=$AZURE_CLIENT_ID" \
  --set-env-vars="AZURE_TENANT_ID=$AZURE_TENANT_ID" \
  --set-env-vars="AZURE_CLIENT_SECRET=$AZURE_CLIENT_SECRET" \
  --set-env-vars="DISCOVERY_PROJECT_ID=$DISCOVERY_PROJECT_ID" \
  --set-env-vars="GOOGLE_WIF_AUDIENCE=$GOOGLE_WIF_AUDIENCE" \
  --set-env-vars="DISCOVERY_ENGINE_DATA_STORE_ID=$DISCOVERY_ENGINE_DATA_STORE_ID" \
  --set-env-vars="EXPRESS_SECRET=$EXPRESS_SECRET" \
  --set-env-vars="APP_BASE_URL=$APP_BASE_URL"
  ```