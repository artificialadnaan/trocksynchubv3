import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Zap } from "lucide-react";

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
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md mx-auto">
        <CardHeader className="text-center space-y-3 px-4 md:px-6">
          <div className="mx-auto w-12 h-12 md:w-14 md:h-14 rounded-xl bg-primary flex items-center justify-center">
            <Zap className="w-6 h-6 md:w-7 md:h-7 text-primary-foreground" />
          </div>
          <CardTitle className="text-xl md:text-2xl font-bold" data-testid="text-login-title">
            Trock Sync Hub 2.0
          </CardTitle>
          <p className="text-xs md:text-sm text-muted-foreground">
            HubSpot + Procore + CompanyCam Middleware
          </p>
        </CardHeader>
        <CardContent className="px-4 md:px-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Input
                placeholder="Username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-11 md:h-10 text-base md:text-sm"
                data-testid="input-username"
              />
            </div>
            <div>
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 md:h-10 text-base md:text-sm"
                data-testid="input-password"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 md:h-10 text-base md:text-sm"
              disabled={loginMutation.isPending}
              data-testid="button-login"
            >
              {loginMutation.isPending ? "Please wait..." : isRegistering ? "Create Account" : "Sign In"}
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
        </CardContent>
      </Card>
    </div>
  );
}
