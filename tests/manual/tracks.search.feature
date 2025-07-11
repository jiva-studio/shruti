Feature: Tracks Search

  Background: User is on the search page
    Given User opens "Search" page

  Scenario: User can see list of tracks on search page
    When User opens "Search" page
    Then List of tracks is not empty

  Scenario: User can load next page of tracks
    When User scrolls to the bottom of the list
    Then New tracks are loaded into the list

  Scenario: User can filter tracks by title
    When User enters "Кришна" in the search input
    Then List of tracks contains only tracks with "Кришна" in the title

  Scenario: User can filter tracks by verse
    When User enters "bg 1.1" in the search input
    Then List of tracks contains only tracks with "bg 1.1" in the verse
    And It includes tracks with "bg 1.11" in the verse

  Scenario: User can filter tracks by author
    When User selects "Aindra das" from the "Authors" filter
    Then List of tracks contains only tracks with "Aindra das" in the author
