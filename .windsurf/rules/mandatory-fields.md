---
trigger: always_on
---

Do not check for the existence/definition/initialization of variables, parameters, etc., unless they are truly optional. If they are mandatory, an actual error should get raised if they come in as null or undefined. Do not hide those errors. Do not make null checks before using parameters or fields, which are actually substantial components of the system -- unless you know from the data flow that there's a specific reason they would be null in this specific situation.