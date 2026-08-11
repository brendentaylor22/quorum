Feature: Phase 0 user journeys
  Contract scenarios remain normative until automated against implementation.

  Background:
    Given every started room has exactly 20 persisted movies
    And membership and eligible count freeze when voting starts
    And results remain hidden until voting completes or host closes voting

  Scenario: Solo participant creates a shortlist
    Given one participant joins a lobby
    When host starts voting and participant confirms all 20 swipes
    Then room becomes COMPLETE
    And every right swipe ranks before every left swipe
    And each right swipe shows 100% (1/1) and Match
    And each left swipe shows 0% (0/1)

  Scenario: Equal scores keep a shared rank
    Given four eligible participants complete voting
    And movies B and C each receive 3 right swipes and 4 responses
    When results are ranked
    Then B and C both show 75% (3/4), 100% coverage, and rank 2
    And next lower movie shows rank 4

  Scenario: Unanimous approval creates a match
    Given four eligible participants complete voting
    And movie A receives four right swipes
    When results are shown
    Then movie A shows 100% (4/4)
    And movie A has a prominent Match badge

  Scenario: Reconnect resumes after last durable confirmation
    Given participant confirmed exposure 7 and did not confirm exposure 8
    When same participant session refreshes room
    Then exposure 8 is shown
    And first 7 confirmed choices remain unchanged
    And no interim result is revealed

  Scenario: Host closes voting early
    Given four eligible participants are voting
    And only one participant right-swiped movie A
    When authorized host closes voting
    Then room becomes COMPLETE
    And movie A shows 25% (1/4), not 100%
    And coverage shows 25%
    And results identify early closure

  Scenario: Expired room reveals no state
    Given room retention has expired
    When any invite, host, or participant capability requests room
    Then response matches uniform invalid-capability response
    And no participant, vote, result, or prior lifecycle state is revealed

  Scenario: Duplicate swipe retry is idempotent
    Given participant confirmed RIGHT for exposure 5
    When participant retries RIGHT for exposure 5 with same idempotency identity
    Then server returns same durable confirmation
    And exactly one interaction exists
    When participant retries LEFT for exposure 5
    Then server returns conflict
    And original RIGHT remains unchanged

  Scenario: Stolen participant cookie stays narrowly scoped
    Given attacker possesses participant A session cookie
    When attacker requests participant B state or host close action
    Then both requests are denied
    And no participant B private choices are revealed
    But participant A cookie can act only on participant A remaining exposures until expiry

  Scenario: Invalid invite is indistinguishable
    Given attacker supplies random or modified invite token
    When join is requested
    Then status, response shape, headers, and comparable processing match expired invite
    And no room existence or lifecycle state is revealed

  Scenario: Twentieth swipe completes voting atomically
    Given all frozen participants except final participant completed 20 swipes
    And final participant completed 19 swipes
    When final participant confirms twentieth exposure
    Then interaction is committed exactly once
    And participant and room become complete
    And canonical results become visible
    And reconnect cannot return twentieth exposure as unconfirmed

