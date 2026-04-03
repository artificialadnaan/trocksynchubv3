import { useState } from 'react';
import { useParams } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Star, CheckCircle, ExternalLink, Loader2 } from 'lucide-react';

const SURVEY_QUESTIONS = [
  { key: 'overallExperience', label: 'How satisfied were you with your overall experience?' },
  { key: 'communication', label: 'How would you rate our communication?' },
  { key: 'schedule', label: 'How satisfied were you with the project schedule?' },
  { key: 'quality', label: 'How would you rate the quality of work?' },
  { key: 'hireAgain', label: 'Would you hire us again?' },
  { key: 'referral', label: 'Would you refer T-Rock?' },
] as const;

type RatingKey = typeof SURVEY_QUESTIONS[number]['key'];

function StarRating({ value, hovered, onSelect, onHover, onLeave }: {
  value: number;
  hovered: number;
  onSelect: (v: number) => void;
  onHover: (v: number) => void;
  onLeave: () => void;
}) {
  return (
    <div className="flex justify-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onClick={() => onSelect(star)}
          onMouseEnter={() => onHover(star)}
          onMouseLeave={onLeave}
          className="p-1.5 transition-transform hover:scale-110 active:scale-95 focus:outline-none touch-manipulation"
        >
          <Star
            className={`h-8 w-8 md:h-9 md:w-9 transition-colors ${
              star <= (hovered || value)
                ? 'fill-yellow-400 text-yellow-400'
                : 'text-gray-300'
            }`}
          />
        </button>
      ))}
    </div>
  );
}

export default function SurveyPage() {
  const { token } = useParams();
  const { toast } = useToast();
  const [ratings, setRatings] = useState<Record<RatingKey, number>>({
    overallExperience: 0, communication: 0, schedule: 0, quality: 0, hireAgain: 0, referral: 0,
  });
  const [hoveredRatings, setHoveredRatings] = useState<Record<RatingKey, number>>({
    overallExperience: 0, communication: 0, schedule: 0, quality: 0, hireAgain: 0, referral: 0,
  });
  const [feedback, setFeedback] = useState('');
  const [googleReviewClicked, setGoogleReviewClicked] = useState(false);
  const [submissionResult, setSubmissionResult] = useState<{ showGoogleReview?: boolean; googleReviewLink?: string | null } | null>(null);

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
        body: JSON.stringify({ ratings, feedback, googleReviewClicked }),
      });
      if (!res.ok) throw new Error('Failed to submit survey');
      return res.json();
    },
    onSuccess: async (data) => {
      toast({ title: 'Thank you!', description: 'Your feedback has been submitted.' });
      setSubmissionResult(data);
      await refetch();
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const allRated = SURVEY_QUESTIONS.every((q) => ratings[q.key] > 0);

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

  // Already submitted — show thank you with conditional Google review
  if (survey.submitted) {
    const showGoogleReview = submissionResult?.showGoogleReview || (survey.googleReviewLink != null);
    const reviewLink = submissionResult?.googleReviewLink || survey.googleReviewLink;

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
          <CardContent className="text-center space-y-4">
            {showGoogleReview && reviewLink && (
              <div className="bg-slate-50 rounded-lg p-4">
                <p className="font-medium mb-2 text-sm">⭐ We're glad you had a great experience!</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Would you mind sharing your experience on Google? It helps others discover T-Rock Construction!
                </p>
                <Button
                  variant="outline"
                  className="gap-2 h-10 text-sm"
                  onClick={() => {
                    setGoogleReviewClicked(true);
                    window.open(reviewLink, '_blank');
                  }}
                >
                  <ExternalLink className="h-4 w-4" />
                  Write a Google Review
                </Button>
              </div>
            )}
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

            <div className="space-y-6">
              {SURVEY_QUESTIONS.map((q, idx) => (
                <div key={q.key} className="space-y-2">
                  <label className="block text-center font-medium text-sm md:text-base">
                    {idx + 1}. {q.label}
                  </label>
                  <StarRating
                    value={ratings[q.key]}
                    hovered={hoveredRatings[q.key]}
                    onSelect={(v) => setRatings((prev) => ({ ...prev, [q.key]: v }))}
                    onHover={(v) => setHoveredRatings((prev) => ({ ...prev, [q.key]: v }))}
                    onLeave={() => setHoveredRatings((prev) => ({ ...prev, [q.key]: 0 }))}
                  />
                  {ratings[q.key] > 0 && (
                    <p className="text-center text-xs text-muted-foreground">
                      {ratings[q.key] === 5 && 'Excellent!'}
                      {ratings[q.key] === 4 && 'Great!'}
                      {ratings[q.key] === 3 && 'Good'}
                      {ratings[q.key] === 2 && 'Fair'}
                      {ratings[q.key] === 1 && 'Poor'}
                    </p>
                  )}
                </div>
              ))}
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

            <Button
              className="w-full bg-gradient-to-r from-red-600 to-red-500 hover:from-red-700 hover:to-red-600 h-12 md:h-11 text-base"
              size="lg"
              onClick={() => submitMutation.mutate()}
              disabled={!allRated || submitMutation.isPending}
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

            {!allRated && (
              <p className="text-center text-xs text-muted-foreground">
                Please rate all {SURVEY_QUESTIONS.length} questions to submit
              </p>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs md:text-sm text-muted-foreground mt-4 md:mt-6">
          © {new Date().getFullYear()} T-Rock Construction. All rights reserved.
        </p>
      </div>
    </div>
  );
}
