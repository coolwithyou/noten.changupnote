import { AdminLoginPanel } from "@/components/AdminLoginPanel";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <AdminLoginPanel
      googleEnabled={Boolean(
        process.env.GOOGLE_CLIENT_ID
        && process.env.GOOGLE_CLIENT_SECRET,
      )}
    />
  );
}
