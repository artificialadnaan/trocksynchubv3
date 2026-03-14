import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, Shield, Zap, BarChart3 } from "lucide-react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const { toast } = useToast();

  const loginMutation = useMutation({
    mutationFn: async (data: { username: string; password: string }) => {
      const res = await apiRequest("POST", isRegistering ? "/api/auth/register" : "/api/auth/login", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate({ username, password });
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      {/* Brand Hero Panel */}
      <div className="hidden md:flex md:w-[45%] lg:w-[42%] bg-[#0a0a0a] relative overflow-hidden flex-col justify-between p-10 lg:p-14">
        {/* Subtle geometric pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{
          backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 40px, #fff 40px, #fff 41px)`,
        }} />

        {/* Red accent bar at top */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-[#d11921]" />

        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-16">
            <img src="/favicon.png" alt="T-Rock" className="w-12 h-12" />
            <div>
              <h1 className="text-white font-display text-lg font-bold tracking-tight leading-none">
                T-Rock Construction
              </h1>
              <p className="text-white/40 text-xs font-medium tracking-wider uppercase mt-0.5">
                Sync Hub
              </p>
            </div>
          </div>

          <div className="space-y-6">
            <h2 className="text-white font-display text-3xl lg:text-4xl font-bold tracking-tight leading-[1.15]">
              Your construction
              <br />
              data, unified.
            </h2>
            <p className="text-white/50 text-sm leading-relaxed max-w-sm">
              Synchronize HubSpot, Procore, and CompanyCam in real-time.
              One platform for all your project intelligence.
            </p>
          </div>

          <div className="mt-12 space-y-4">
            {[
              { icon: Zap, label: "Real-time sync across platforms" },
              { icon: Shield, label: "Automated RFP & approval workflows" },
              { icon: BarChart3, label: "Project archiving & reporting" },
            ].map((item) => (
              <div key={item.label} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-white/[0.06] border border-white/[0.08] flex items-center justify-center flex-shrink-0">
                  <item.icon className="w-4 h-4 text-[#d11921]" />
                </div>
                <span className="text-white/60 text-sm">{item.label}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-white/20 text-xs">
          T-Rock Construction, LLC
        </p>
      </div>

      {/* Login Form Panel */}
      <div className="flex-1 flex items-center justify-center p-6 md:p-10 bg-background">
        <div className="w-full max-w-sm">
          {/* Mobile logo */}
          <div className="md:hidden flex items-center gap-3 mb-10">
            <img src="/favicon.png" alt="T-Rock" className="w-10 h-10" />
            <div>
              <h1 className="font-display text-lg font-bold tracking-tight leading-none text-foreground">
                T-Rock Construction
              </h1>
              <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase mt-0.5">
                Sync Hub
              </p>
            </div>
          </div>

          <div className="space-y-2 mb-8">
            <h2 className="font-display text-2xl font-bold tracking-tight text-foreground" data-testid="text-login-title">
              {isRegistering ? "Create account" : "Welcome back"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isRegistering
                ? "Set up your credentials to get started."
                : "Sign in to access your sync dashboard."
              }
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Username</label>
              <Input
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-11 text-sm bg-card border-border"
                data-testid="input-username"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Password</label>
              <Input
                type="password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 text-sm bg-card border-border"
                data-testid="input-password"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 text-sm font-semibold gap-2 mt-2"
              disabled={loginMutation.isPending}
              data-testid="button-login"
            >
              {loginMutation.isPending
                ? "Please wait..."
                : isRegistering
                  ? "Create Account"
                  : "Sign In"
              }
              {!loginMutation.isPending && <ArrowRight className="w-4 h-4" />}
            </Button>
            <button
              type="button"
              onClick={() => setIsRegistering(!isRegistering)}
              className="w-full py-2 text-sm text-muted-foreground hover:text-foreground transition-colors active:scale-[0.98]"
              data-testid="button-toggle-register"
            >
              {isRegistering ? "Already have an account? Sign in" : "Need an account? Register"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
