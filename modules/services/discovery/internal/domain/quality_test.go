package domain_test

import (
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

func TestIsSearchableTranscript(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{
			name: "empty",
			text: "",
			want: false,
		},
		{
			name: "whitespace only",
			text: "   \n\t  ",
			want: false,
		},
		{
			name: "normal short lecture",
			text: "Today we are discussing Srimad Bhagavatam Canto 1 Chapter 2 Text 16 in Los Angeles.",
			want: true,
		},
		{
			name: "normal long lecture Russian",
			text: `Дорогие преданные, сегодня мы читаем Шримад-Бхагаватам, первая песнь, вторая глава, стих шестнадцатый.
Шрила Прабхупада объясняет, что служение чистым преданным очищает сердце от всех неблагоприятных желаний.
Когда человек искренне слушает повествования о Кришне, его ум освобождается от скверны материального существования.
В этом стихе Сута Госвами подчеркивает важность общения со святыми личностями, саду-санга.
Без милости вайшнавов невозможно развить устойчивый вкус к воспеванию святого имени.
Поэтому каждый практикующий должен стремиться к бескорыстному служению и внимательному слушанию священных писаний.`,
			want: true,
		},
		{
			name: "pure Japa repeating Mahamantra 100 times",
			text: strings.Repeat("हरे कृष्णा हरे कृष्णा कृष्णा कृष्णा हरे हरे हरे राम हरे राम राम राम हरे हरे ", 100),
			want: false,
		},
		{
			name: "pure Japa with music tags",
			text: strings.Repeat("कृष्ण ने राम अरे कृष्ण हरे कृष्ण कृष्ण हरे हरे राम [संगीत] राम हरे हरे राम राम जय हरे राम ", 60),
			want: false,
		},
		{
			name: "noise tags dominant",
			text: strings.Repeat("[music] [applause] [laughter] some words [music] [applause] ", 30),
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := domain.IsSearchableTranscript(tt.text)
			if got != tt.want {
				t.Errorf("IsSearchableTranscript() = %v, want %v", got, tt.want)
			}
		})
	}
}
