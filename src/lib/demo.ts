// Demo recruiter used by the one-click "light bulb" quick-login in the navbar.
// These credentials are intentionally shared client-side so the demo button
// can sign in through the normal credentials provider. The account is created
// on demand (idempotently) by POST /api/demo-recruiter.
export const DEMO_RECRUITER = {
    name: "John Doe",
    email: "john.doe@luminahire.com",
    password: "JohnDoe@2026",
    companyName: "Doe Talent Partners",
} as const;
