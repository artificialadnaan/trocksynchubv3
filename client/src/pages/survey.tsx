import { useState } from 'react';
import { useParams } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Star, CheckCircle, ExternalLink, Loader2 } from 'lucide-react';

export default function SurveyPage() {
  const { token } = useParams();
  const { toast } = useToast();
  const [rating, setRating] = useState(0);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [googleReviewClicked, setGoogleReviewClicked] = useState(false);

  const { data: survey, isLoading, error, refetch } = useQuery({
    queryKey: ['survey', token],
    queryFn: async () => {
      const res = await fetch(`/api/survey/${token}`);
      if (!res.ok) throw new Error('Survey not found');
      return res.json();
    },
    enabled: !!token,
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/survey/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, feedback, googleReviewClicked }),
      });
      if (!res.ok) throw new Error('Failed to submit survey');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Thank you!', description: 'Your feedback has been submitted.' });
      refetch();
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !survey) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-destructive">Survey Not Found</CardTitle>
            <CardDescription>
              This survey link is invalid or has expired.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  if (survey.submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle className="h-8 w-8 text-green-600" />
              </div>
            </div>
            <CardTitle className="text-green-600">Thank You!</CardTitle>
            <CardDescription>
              Your feedback for <strong>{survey.projectName}</strong> has been submitted.
              We truly appreciate you taking the time to share your experience.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <div className="flex justify-center gap-1 mb-4">
              {[1, 2, 3, 4, 5].map((star) => (
                <Star
                  key={star}
                  className={`h-6 w-6 ${star <= survey.rating ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'}`}
                />
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              Your rating: {survey.rating}/5
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-slate-200 p-3 md:p-4">
      <div className="max-w-2xl mx-auto py-4 md:py-8">
        <div className="text-center mb-6 md:mb-8">
          <img 
            src="https://trockgc.com/wp-content/uploads/2024/10/T-Rock-Logo-Main-2.png" 
            alt="T-Rock Construction" 
            className="h-12 md:h-16 mx-auto mb-4"
          />
        </div>

        <Card className="shadow-xl">
          <CardHeader className="text-center border-b bg-gradient-to-r from-slate-900 to-slate-800 text-white rounded-t-lg px-4 py-6 md:p-6">
            <CardTitle className="text-xl md:text-2xl">Project Complete!</CardTitle>
            <CardDescription className="text-slate-300 text-sm md:text-base">
              We'd love to hear about your experience
            </CardDescription>
          </CardHeader>
          
          <div className="h-1 bg-gradient-to-r from-red-600 to-red-500" />
          
          <CardContent className="p-4 md:p-8 space-y-6 md:space-y-8">
            <div className="text-center">
              <p className="text-base md:text-lg mb-2">
                Dear <strong>{survey.clientName}</strong>,
              </p>
              <p className="text-muted-foreground text-sm md:text-base">
                Thank you for choosing T-Rock Construction for{' '}
                <strong>{survey.projectName}</strong>. Your feedback helps us
                continue delivering exceptional results.
              </p>
            </div>

            <div className="space-y-4">
              <label className="block text-center font-medium text-sm md:text-base">
                How would you rate your overall experience?
              </label>
              <div className="flex justify-center gap-1 md:gap-2">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setRating(star)}
                    onMouseEnter={() => setHoveredRating(star)}
                    onMouseLeave={() => setHoveredRating(0)}
                    className="p-2 md:p-1 transition-transform hover:scale-110 active:scale-95 focus:outline-none touch-manipulation"
                  >
                    <Star
                      className={`h-10 w-10 md:h-10 md:w-10 transition-colors ${
                        star <= (hoveredRating || rating)
                          ? 'fill-yellow-400 text-yellow-400'
                          : 'text-gray-300'
                      }`}
                    />
                  </button>
                ))}
              </div>
              {rating > 0 && (
                <p className="text-center text-sm text-muted-foreground">
                  {rating === 5 && 'Excellent!'}
                  {rating === 4 && 'Great!'}
                  {rating === 3 && 'Good'}
                  {rating === 2 && 'Fair'}
                  {rating === 1 && 'Poor'}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="block font-medium text-sm md:text-base">
                Additional Comments (Optional)
              </label>
              <Textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Share any specific feedback about your experience..."
                rows={4}
                className="text-base md:text-sm"
              />
            </div>

            {survey.googleReviewLink && (
              <div className="bg-slate-50 rounded-lg p-3 md:p-4 text-center">
                <p className="font-medium mb-2 text-sm md:text-base">⭐ Love your experience?</p>
                <p className="text-xs md:text-sm text-muted-foreground mb-3">
                  Consider leaving us a Google review to help others discover T-Rock Construction!
                </p>
                <Button
                  variant="outline"
                  className="gap-2 h-10 md:h-9 text-sm"
                  onClick={() => {
                    setGoogleReviewClicked(true);
                    window.open(survey.googleReviewLink, '_blank');
                  }}
                >
                  <ExternalLink className="h-4 w-4" />
                  Write a Google Review
                </Button>
              </div>
            )}

            <Button
              className="w-full bg-gradient-to-r from-red-600 to-red-500 hover:from-red-700 hover:to-red-600 h-12 md:h-11 text-base"
              size="lg"
              onClick={() => submitMutation.mutate()}
              disabled={rating === 0 || submitMutation.isPending}
            >
              {submitMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Submitting...
                </>
              ) : (
                'Submit Feedback'
              )}
            </Button>
          </CardContent>
        </Card>

        <p className="text-center text-xs md:text-sm text-muted-foreground mt-4 md:mt-6">
          © {new Date().getFullYear()} T-Rock Construction. All rights reserved.
        </p>
      </div>
    </div>
  );
}
