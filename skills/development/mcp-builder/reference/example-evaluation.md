> Adapted from the upstream `mcp-builder` skill (Apache-2.0); the changes are listed in `SOURCE.md`.

# Example evaluation file

Upstream shipped this as `scripts/example_evaluation.xml`, the sample input of its evaluation runner. It shows the
file format only: its questions are arithmetic and need no MCP server. For how to write real questions and run them
with the tools you already have, see `evaluation.md`.

```xml
<evaluation>
   <qa_pair>
      <question>Calculate the compound interest on $10,000 invested at 5% annual interest rate, compounded monthly for 3 years. What is the final amount in dollars (rounded to 2 decimal places)?</question>
      <answer>11614.72</answer>
   </qa_pair>
   <qa_pair>
      <question>A projectile is launched at a 45-degree angle with an initial velocity of 50 m/s. Calculate the total distance (in meters) it has traveled from the launch point after 2 seconds, assuming g=9.8 m/s². Round to 2 decimal places.</question>
      <answer>87.25</answer>
   </qa_pair>
   <qa_pair>
      <question>A sphere has a volume of 500 cubic meters. Calculate its surface area in square meters. Round to 2 decimal places.</question>
      <answer>304.65</answer>
   </qa_pair>
   <qa_pair>
      <question>Calculate the population standard deviation of this dataset: [12, 15, 18, 22, 25, 30, 35]. Round to 2 decimal places.</question>
      <answer>7.61</answer>
   </qa_pair>
   <qa_pair>
      <question>Calculate the pH of a solution with a hydrogen ion concentration of 3.5 × 10^-5 M. Round to 2 decimal places.</question>
      <answer>4.46</answer>
   </qa_pair>
</evaluation>
```
