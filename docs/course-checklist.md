# CSE216 Project Checklists

> Text of the course handout `CSE216 Project Checklists` (Google Docs export),
> converted to Markdown. Wording is unchanged; only the layout is.

**Note:** The examples mentioned in the checklist refer to a sample/dummy
project called a 'Research Network Social Platform' and are provided only to
illustrate appropriate use cases.

**Dummy project:** Research Network Social Platform (similar to academic
collaboration networks such as ResearchGate). The system may allow researchers
to create profiles, upload publications, follow other researchers, join
research groups, and track citations.

---

## 1. User Authentication

Ensure that authentication of users is handled by your own code (not through
any third party service). You may use session_id or JWT for handling user
authentication.

## 2. Authentication Validation on Every Page

You must check authentication on every page to ensure that a user is
authenticated before processing any HTTP request.

## 3. Explicit Transaction Control

Ensure that you implement explicit transaction control in every DML operation
in the database. Explicit transaction control means you must use COMMIT and
ROLLBACK if your server executes a transaction involving insert, update, or
delete operations.

*Example:* When uploading a publication, the system inserts the paper, inserts
authors, and updates researcher statistics. If any step fails, the transaction
should be rolled back.

## 4. Use of Triggers

Ensure that you use one or more triggers. Triggers can be used for data
validation before DML operations or for logging sensitive actions to a shadow
table.

*Example:* A trigger may automatically update the citation count of a
publication when a new citation record is inserted.

## 5. Use of Functions

Ensure that you use one or more functions. Functions should be used when a
statistical or computed value must be returned from the database.

*Example:* A function may return the h-index of a researcher calculated from
their publications and citation counts.

## 6. Use of Procedures

Ensure that you use at least one procedure. Procedures should be used when a
multi-step workflow modifies several tables in one operation.

*Example:* A procedure may handle uploading a publication, which inserts the
paper, records multiple authors, and updates publication statistics in one
transaction.

## 7. Use of Complex Queries

Ensure that your project uses three or more complex queries. A complex query
is defined as one that retrieves data from multiple tables and/or uses
aggregation functions.

*Example:* A query that lists top researchers in a research field based on
total citations across all their publications. You may implement statistical
or analytics pages (such as 'Top Researchers', 'Most Cited Papers', or 'Active
Research Groups') to demonstrate these complex queries.

## 8. Appropriate Use of Database Features

Ensure that database features are used only where appropriate. Avoid
implementing unnecessary triggers, procedures, or functions. Correct
identification of appropriate use cases is an important part of the
evaluation.

## 9. You must be capable to write your own code

Ensure that you understand each and every part of your code. During
evaluation, you may be asked to write a part of your source code for
verification.

---

Where each item lives in this repository:
[COURSE-REQUIREMENTS.md](COURSE-REQUIREMENTS.md).
