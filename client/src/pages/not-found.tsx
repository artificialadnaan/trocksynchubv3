import { Card, CardContent } from "@/components/ui/card";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <Card className="w-full max-w-md mx-4 border-l-[3px] border-l-primary">
        <CardContent className="pt-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <span className="text-primary font-display font-bold text-lg">404</span>
            </div>
            <div>
              <h1 className="text-xl font-bold font-display text-foreground">Page Not Found</h1>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                This page doesn't exist. Check the URL or navigate back from the sidebar.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
