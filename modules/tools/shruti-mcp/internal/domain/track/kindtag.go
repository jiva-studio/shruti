package track

// KindTagToID maps the canonical KindTag slug emitted by the metadata
// extractor (morning_walk, conversation, …) to the seeded catalog tag_id
// that commit writes into track_variants.tag_id. Empty slug → empty id.
//
// The seed itself lives in the catalog sqlite layer (SeededKindTags); this
// table is the cross-layer lookup the application stage needs without
// pulling in infra.
func KindTagToID(slug string) string {
	switch slug {
	case "morning_walk":
		return "tag_morning_walk"
	case "conversation":
		return "tag_conversation"
	case "interview":
		return "tag_interview"
	case "press_conference":
		return "tag_press_conf"
	case "address":
		return "tag_address"
	case "vyasa_puja":
		return "tag_vyasa_puja"
	case "initiation":
		return "tag_initiation"
	case "wedding":
		return "tag_wedding"
	case "festival":
		return "tag_festival"
	case "bhajan":
		return "tag_bhajan"
	case "other":
		return "tag_other"
	}
	return ""
}
